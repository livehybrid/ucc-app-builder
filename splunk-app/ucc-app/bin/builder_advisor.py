"""
UCC App Builder — "App Builder Advisor" REST handler (the in-app agent).

Runs an agent via the **Splunk Agent SDK (splunklib.ai)** that authors a UCC
add-on by calling the local tools (builder_agent_tools, tagged `ucc_builder`) and
the ucc-gen + AppInspect build loop. The LLM is provider-agnostic; we default to
an OpenAI-compatible endpoint pointed at **OpenRouter** (so it reuses the existing
OpenRouter key/credit — no SAIA, no Splunk hosted models required).

  POST /ucc_app_builder/advisor   { "prompt": "...", "model": "..." }

ARCHITECTURE NOTE — why the agent runs in a subprocess:
splunkd runs persistent REST handlers in a SHARED interpreter that has many OTHER
apps' libraries cached. Importing our vendored agent stack (splunklib.ai 3.0,
pydantic v2, typing_extensions, langchain, …) in-process collides
non-deterministically with whatever another app loaded first. So this handler stays
thin — it reads the secret/conf via splunk.rest (safe; that's Splunk's own module),
then spawns `bin/advisor_runner.py` as a fresh `/opt/splunk/bin/python3` subprocess
with PYTHONPATH = our lib only (a pristine interpreter, like the SDK's own tools.py
spawn) and exchanges JSON over stdin/stdout.

Config (ucc_app_builder_settings.conf [advisor]): ai_base_url
(default https://openrouter.ai/api/v1), ai_model, max_steps; API key in
storage/passwords (realm ucc_app_builder, user openrouter_api_key).
"""
import json
import os
import subprocess
import sys

from splunk.persistconn.application import PersistentServerConnectionApplication

_BIN = os.path.dirname(os.path.abspath(__file__))
_LIB = os.path.join(os.path.dirname(_BIN), "lib")
# Make the app's vendored libs importable in-process (for solnlib, used to read the
# UCC Configuration-page key). splunkd does not add <app>/lib to a handler's sys.path.
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)
_RUNNER = os.path.join(_BIN, "advisor_runner.py")
_SPLUNK_HOME = os.path.normpath(os.path.join(_BIN, "..", "..", "..", ".."))

APP = "ucc_app_builder"
DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "anthropic/claude-sonnet-4.6"


def _json_response(payload, status=200):
    return {"status": status, "payload": json.dumps(payload),
            "headers": {"Content-Type": "application/json"}}


def _get_session_key(req):
    sess = req.get("session", {}) if isinstance(req, dict) else {}
    if isinstance(sess, dict):
        return sess.get("authtoken") or sess.get("sessionKey")
    return None


def _get_secret(session_key, user="openrouter_api_key", realm=APP):
    import splunk.rest as rest
    try:
        _, body = rest.simpleRequest(
            f"/servicesNS/nobody/{APP}/storage/passwords/{realm}%3A{user}%3A?output_mode=json",
            sessionKey=session_key, method="GET", raiseAllErrors=False)
        entry = json.loads(body).get("entry", [])
        if entry:
            return entry[0].get("content", {}).get("clear_password")
    except Exception:
        pass
    return None


def _api_key_for(session_key, provider):
    # Per-provider key (e.g. openrouter_api_key), falling back to the openrouter key.
    return (_get_secret(session_key, f"{provider}_api_key")
            or _get_secret(session_key, "openrouter_api_key"))


SETTINGS_CONF = APP + "_settings"
_UCC_REALM = f"__REST_CREDENTIAL__#{APP}#configs/conf-{SETTINGS_CONF}"


def ucc_ai_settings(session_key):
    """Read the UCC Configuration page [ai_provider] stanza (api_key decrypted) via
    solnlib — the canonical, unified AI-provider config. Returns {} on any failure so
    callers fall back to the legacy [advisor] stanza + custom storage/passwords realm."""
    try:
        from solnlib import conf_manager
        cfm = conf_manager.ConfManager(session_key, APP, realm=_UCC_REALM)
        conf = cfm.get_conf(SETTINGS_CONF)
        return dict(conf.get("ai_provider") or {})
    except Exception:
        return {}


def _get_conf(session_key, key, default=""):
    import splunk.rest as rest
    try:
        _, body = rest.simpleRequest(
            f"/servicesNS/nobody/{APP}/configs/conf-ucc_app_builder_settings/advisor?output_mode=json",
            sessionKey=session_key, method="GET", raiseAllErrors=False)
        entry = json.loads(body).get("entry", [])
        if entry:
            return entry[0].get("content", {}).get(key) or default
    except Exception:
        pass
    return default


def _run_in_subprocess(payload, timeout):
    """Spawn advisor_runner.py in a pristine interpreter (PYTHONPATH = our lib only)
    and exchange JSON over stdin/stdout. Returns the parsed result dict."""
    env = {
        "SPLUNK_HOME": _SPLUNK_HOME,
        "SPLUNK_DB": os.path.join(_SPLUNK_HOME, "var", "lib", "splunk"),
        "LD_LIBRARY_PATH": os.path.join(_SPLUNK_HOME, "lib"),
        "PYTHONPATH": _LIB + os.pathsep + _BIN,
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
    }
    python = os.path.join(_SPLUNK_HOME, "bin", "python3")
    proc = subprocess.run(
        [python, _RUNNER],
        input=json.dumps(payload), capture_output=True, text=True,
        env=env, timeout=timeout,
    )
    out = (proc.stdout or "").strip()
    # The runner prints exactly one JSON object as its LAST line.
    for line in reversed(out.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                continue
    return {"error": "runner produced no JSON",
            "trace": (proc.stderr or "")[-1500:] or out[-1500:]}


class AdvisorHandler(PersistentServerConnectionApplication):
    def __init__(self, command_line=None, command_arg=None):
        super(AdvisorHandler, self).__init__()

    def handle(self, in_string):
        try:
            req = json.loads(in_string) if in_string else {}
            session_key = _get_session_key(req)
            if not session_key:
                return _json_response({"error": "Missing session key"}, status=401)
            args = {}
            payload = req.get("payload")
            if isinstance(payload, str) and payload.strip():
                try:
                    args = json.loads(payload)
                except ValueError:
                    args = {}
            prompt = str(args.get("prompt") or "").strip()
            if not prompt:
                return _json_response({"error": "prompt is required"}, status=400)

            # Unified AI-provider config: prefer the UCC Configuration page
            # ([ai_provider]); fall back to the legacy [advisor] stanza + custom realm.
            ucc = ucc_ai_settings(session_key)
            provider = str(args.get("provider") or ucc.get("provider")
                           or _get_conf(session_key, "ai_provider", "openrouter")).lower()
            base_url = (ucc.get("base_url")
                        or _get_conf(session_key, "ai_base_url", DEFAULT_BASE_URL))
            model_name = str(args.get("model") or ucc.get("model")
                             or _get_conf(session_key, "ai_model", DEFAULT_MODEL))
            temperature = args.get("temperature")
            if temperature is None or temperature == "":
                temperature = ucc.get("temperature") or _get_conf(session_key, "temperature", "")
            api_key = ucc.get("api_key") or _api_key_for(session_key, provider)
            if not api_key:
                return _json_response({"error": f"No API key for provider '{provider}'. Set one in "
                                                "the app's Configuration → AI Provider tab."}, status=400)
            try:
                max_steps = int(args.get("max_steps") or ucc.get("max_iterations")
                                or _get_conf(session_key, "max_steps", "40"))
            except (TypeError, ValueError):
                max_steps = 40
            try:
                timeout = int(args.get("timeout") or _get_conf(session_key, "timeout", "600"))
            except (TypeError, ValueError):
                timeout = 600

            result = _run_in_subprocess({
                "session_key": session_key, "prompt": prompt, "model": model_name,
                "base_url": base_url, "api_key": api_key, "max_steps": max_steps,
                "provider": provider, "temperature": temperature,
            }, timeout=timeout)
            status = 200 if result.get("ok") else 500
            return _json_response(result, status=status)
        except subprocess.TimeoutExpired:
            return _json_response({"error": f"advisor run exceeded timeout"}, status=504)
        except BaseException as e:  # noqa: BLE001
            import traceback
            return _json_response({"error": f"{type(e).__name__}: {e}",
                                   "trace": traceback.format_exc()[-1800:]}, status=500)
