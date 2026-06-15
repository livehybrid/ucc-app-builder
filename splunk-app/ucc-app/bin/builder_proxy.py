"""
UCC App Builder — same-origin API proxy for the embedded SPA.

The full React SPA is served from this app's appserver/static and mounted by a Splunk
dashboard page. Its API traffic (`/api/...`) is repointed by the page's loader to
`/<locale>/splunkd/__raw/services/ucc_app_builder/proxy/api/...`, which lands here. We
forward method + path + query + body to the Node build engine on localhost and return
its response — server-side, so there is no mixed-content / CORS / cert problem and the
existing backend is reused. (Responses are buffered; streaming endpoints arrive at
completion rather than incrementally, which the SPA's SSE parser tolerates.)

The engine base URL comes from ucc_app_builder_settings.conf [build_engine] url
(default http://127.0.0.1:3011).
"""
import importlib.util
import json
import os
import sys

from splunk.persistconn.application import PersistentServerConnectionApplication

_bin = os.path.dirname(os.path.abspath(__file__))
# Make <app>/lib importable in-process (for solnlib, used to read the UCC
# Configuration-page key). splunkd does not add <app>/lib to a handler's sys.path.
_lib = os.path.join(os.path.dirname(_bin), "lib")
if _lib not in sys.path:
    sys.path.insert(0, _lib)
_spec = importlib.util.spec_from_file_location("builder_common", os.path.join(_bin, "builder_common.py"))
builder_common = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(builder_common)
get_session_key = builder_common.get_session_key

APP = "ucc_app_builder"
DEFAULT_ENGINE = "http://127.0.0.1:3011"
SETTINGS_CONF = APP + "_settings"
_UCC_REALM = f"__REST_CREDENTIAL__#{APP}#configs/conf-{SETTINGS_CONF}"


def _ucc_ai(session_key):
    """The UCC Configuration page [ai_provider] stanza (api_key decrypted) via solnlib.
    Returns {} on failure so the engine falls back to its env key/models."""
    try:
        from solnlib import conf_manager
        cfm = conf_manager.ConfManager(session_key, APP, realm=_UCC_REALM)
        conf = cfm.get_conf(SETTINGS_CONF)
        return dict(conf.get("ai_provider") or {})
    except Exception:
        return {}


def _ucc_key(session_key):
    """LLM API key from the UCC Configuration page — injected to the engine as
    X-OpenRouter-Key so the embedded SPA's AI uses the SAME key as the in-Splunk advisor."""
    return _ucc_ai(session_key).get("api_key") or None


def _engine_base(session_key):
    import splunk.rest as rest
    try:
        _, body = rest.simpleRequest(
            f"/servicesNS/nobody/{APP}/configs/conf-ucc_app_builder_settings/build_engine?output_mode=json",
            sessionKey=session_key, method="GET", raiseAllErrors=False)
        entry = json.loads(body).get("entry", [])
        if entry:
            url = entry[0].get("content", {}).get("url")
            if url:
                return url.rstrip("/")
    except Exception:
        pass
    return DEFAULT_ENGINE


def _sub_path(req):
    # The page passes the full engine path+query in the `p` query param (so the splunkd
    # path stays a single segment '.../proxy' that one web.conf expose pattern allows).
    for k, v in (req.get("query") or []):
        if k == "p" and v:
            return v
    # Fallback: anything after '.../proxy' in the path.
    for key in ("path_info", "rest_path", "path"):
        v = req.get(key)
        if isinstance(v, str) and v:
            idx = v.find("/proxy")
            if idx >= 0:
                return v[idx + len("/proxy"):] or "/"
    return "/"


class ProxyHandler(PersistentServerConnectionApplication):
    def __init__(self, command_line=None, command_arg=None):
        super(ProxyHandler, self).__init__()

    def handle(self, in_string):
        import ssl
        import urllib.error
        import urllib.parse
        import urllib.request
        try:
            req = json.loads(in_string) if in_string else {}
            session_key = get_session_key(req)
            if not session_key:
                return {"status": 401, "payload": json.dumps({"error": "Missing session key"})}

            base = _engine_base(session_key)
            # path already carries the original path + query (passed via `p`).
            url = base + _sub_path(req)

            method = (req.get("method") or "GET").upper()
            payload = req.get("payload")
            data = payload.encode("utf-8") if isinstance(payload, str) and payload != "" else None

            # Forward a minimal, safe header set (content-type matters for JSON bodies).
            headers = {"Content-Type": "application/json"}
            for h in (req.get("headers") or []):
                try:
                    k, v = h
                except (ValueError, TypeError):
                    continue
                if k and k.lower() in ("content-type", "accept"):
                    headers[k] = v

            # Unify AI key + per-function models from the Configuration page: hand the
            # engine the key (same credential as the in-Splunk advisor) and the chat /
            # build / completion model choices so the SPA picks them up via /api/ai/config.
            ucc_ai = _ucc_ai(session_key)
            key = ucc_ai.get("api_key")
            if key:
                headers["X-OpenRouter-Key"] = key
            for hdr, field in (("X-Chat-Model", "model"), ("X-Build-Model", "build_model"),
                               ("X-Completion-Model", "completion_model")):
                val = ucc_ai.get(field)
                if val:
                    headers[hdr] = str(val)

            r = urllib.request.Request(url, data=data, method=method, headers=headers)
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            try:
                with urllib.request.urlopen(r, timeout=600, context=ctx) as resp:
                    body = resp.read().decode("utf-8", "replace")
                    ct = resp.headers.get_content_type() or "application/json"
                    return {"status": resp.status, "payload": body, "headers": {"Content-Type": ct}}
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace")
                return {"status": e.code, "payload": body,
                        "headers": {"Content-Type": e.headers.get_content_type() if e.headers else "application/json"}}
        except Exception as e:  # noqa: BLE001
            return {"status": 502, "payload": json.dumps({"error": f"proxy error: {e}"}),
                    "headers": {"Content-Type": "application/json"}}
