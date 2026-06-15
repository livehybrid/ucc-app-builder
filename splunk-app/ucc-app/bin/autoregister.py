"""Self-registration endpoint for the UCC App Builder's MCP tools, fired by
app.conf [triggers] when tools.conf is (re)loaded (install / enable / upgrade).

Cloud vs Enterprise aware:
  * Splunk Cloud (server/info instance_type == "cloud"): a native synced-apps
    registrar already registers MCP tools on install, so this no-ops.
  * Splunk Enterprise (instance_type is None / not "cloud"): older MCP servers have
    no tool_registration endpoint and no native registrar, so register the tools by
    upserting them into the Splunk MCP Server's mcp_tools + mcp_tools_enabled KV
    collections from this app's signatures file. Idempotent (full-doc replace by _key).

Also callable directly (POST /services/ucc_app_builder/autoregister) as a one-shot.
Runs with passSystemAuth=true (system session key).
"""
import json
import os
import urllib.parse

from splunk.persistconn.application import PersistentServerConnectionApplication

try:
    import splunk.rest as rest
except Exception:  # pragma: no cover - only importable inside splunkd
    rest = None

APP = "ucc_app_builder"
SIG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "appserver", "static", "tool_input_payload_signatures.json")
KV = "/servicesNS/nobody/Splunk_MCP_Server/storage/collections/data"


def _status(resp):
    try:
        return int(getattr(resp, "status", resp.get("status") if isinstance(resp, dict) else 500))
    except Exception:
        return 500


def _instance_type(sk):
    resp, content = rest.simpleRequest(
        "/services/server/info?output_mode=json", sessionKey=sk, method="GET", raiseAllErrors=False)
    try:
        return (json.loads(content).get("entry") or [{}])[0].get("content", {}).get("instance_type")
    except Exception:
        return None


def _post(sk, url, doc):
    # simpleRequest may RAISE on 4xx even with raiseAllErrors=False; swallow it and
    # signal "needs fallback" with None.
    try:
        resp, _ = rest.simpleRequest(url, sessionKey=sk, method="POST",
                                     jsonargs=json.dumps(doc), raiseAllErrors=False)
        return _status(resp)
    except Exception:
        return None


def _upsert(sk, collection, key, doc):
    enc = urllib.parse.quote(key, safe="")
    st = _post(sk, f"{KV}/{collection}/{enc}", doc)   # update existing
    if st is not None and st < 400:
        return st
    return _post(sk, f"{KV}/{collection}", doc) or 0  # insert new (doc carries _key)


def _register_kv(sk):
    with open(SIG) as fh:
        tools = json.load(fh)
    out = []
    for t in tools:
        tid = t["tool_id"]
        doc = dict(t)
        doc["_key"] = tid
        s1 = _upsert(sk, "mcp_tools", tid, doc)
        s2 = _upsert(sk, "mcp_tools_enabled", t["name"],
                     {"_key": t["name"], "tool_id": tid, "collision_ids": []})
        out.append({"name": t["name"], "mcp_tools": s1, "enabled": s2})
    return out


class AutoRegisterHandler(PersistentServerConnectionApplication):
    def __init__(self, command_line=None, command_arg=None):
        super(AutoRegisterHandler, self).__init__()

    def handle(self, in_string):
        try:
            req = json.loads(in_string) if in_string else {}
            sk = req.get("system_authtoken") or (req.get("session") or {}).get("authtoken")
            if rest is None or not sk:
                return {"payload": json.dumps({"ok": False, "error": "no system session key"}), "status": 200}
            itype = _instance_type(sk)
            if itype == "cloud":
                return {"payload": json.dumps({"ok": True, "instance_type": itype,
                        "action": "skipped (native Cloud synced-apps registrar handles it)"}), "status": 200}
            return {"payload": json.dumps({"ok": True, "instance_type": itype,
                    "action": "kv_upsert", "results": _register_kv(sk)}), "status": 200}
        except Exception as exc:  # noqa: BLE001 - never raise out of a reload trigger
            return {"payload": json.dumps({"ok": False, "error": str(exc)}), "status": 200}
