#!/usr/bin/env python3
"""
Register the UCC App Builder's tools into the Splunk MCP Server so the Splunk AI
Assistant (and any MCP client) can call them. Mirrors how the Data Dictionary
registers, but as API-execution tools that proxy to this app's REST endpoints.

Two KV collections in Splunk_MCP_Server must both have the tool:
  - mcp_tools          : the tool definition (name, schema, _meta.execution=api)
  - mcp_tools_enabled  : { _key: <name>, tool_id, collision_ids: [] }

Usage:  python3 register_mcp_tools.py            # register/enable all tools
        python3 register_mcp_tools.py --remove   # deregister (cleanup)
Env: SPLUNK_HOST (default 192.168.0.222), SPLUNK_PASSWORD (admin).
"""
import json
import os
import ssl
import sys
import urllib.request

HOST = os.environ.get("SPLUNK_HOST", "192.168.0.222").strip() or "192.168.0.222"
PW = os.environ.get("SPLUNK_PASSWORD", "")
APP = "ucc_app_builder"
BASE = f"https://{HOST}:8089/servicesNS/nobody/Splunk_MCP_Server/storage/collections/data"

# name, method, endpoint, description, properties, required, body($arg$ placeholders
# forwarded by the MCP server's _substitute_placeholders; exact "$k$" returns the
# raw typed value and unfilled optional placeholders are dropped).
TOOLS = [
    ("ucc_ping", "GET", "/services/ucc_app_builder/ping",
     "Health check for the UCC App Builder. Returns { ok, appId, files }. Call first to verify connectivity.",
     {}, [], None),
    ("ucc_create_addon", "POST", "/services/ucc_app_builder/create_addon",
     "Start (or reset) a UCC add-on project for this session. appId is derived (TA_<name>). Call first, then author globalConfig.json with ucc_write_file.",
     {"name": {"type": "string", "description": "Add-on name, e.g. github_audit."},
      "version": {"type": "string", "description": "Semver, default 1.0.0."}}, ["name"],
     {"name": "$name$", "version": "$version$"}),
    ("ucc_write_file", "POST", "/services/ucc_app_builder/write_file",
     "Author or overwrite a project file (globalConfig.json, package/bin/<input>.py, ...). Confined to the project subtree.",
     {"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"],
     {"path": "$path$", "content": "$content$"}),
    ("ucc_read_file", "POST", "/services/ucc_app_builder/read_file",
     "Read one project file back.",
     {"path": {"type": "string"}}, ["path"],
     {"path": "$path$"}),
    ("ucc_list_project", "GET", "/services/ucc_app_builder/list_project",
     "List the files currently in the add-on project.",
     {}, [], None),
    ("ucc_build_and_inspect", "POST", "/services/ucc_app_builder/build_and_inspect",
     "Run ucc-gen build -> Splunk AppInspect -> auto-fix until AppInspect-CLEAN (or maxIterations). Returns the trace + findings. Author globalConfig.json first.",
     {"maxIterations": {"type": "integer"}, "includeWarnings": {"type": "boolean"}}, [],
     {"maxIterations": "$maxIterations$", "includeWarnings": "$includeWarnings$"}),
    ("ucc_package", "POST", "/services/ucc_app_builder/package",
     "Build + AppInspect-validate with auto-fix and return the path to an installable, AppInspect-clean .tar.gz.",
     {}, [], {}),
]


def _ctx():
    c = ssl.create_default_context()
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    return c


def _req(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    import base64
    r.add_header("Authorization", "Basic " + base64.b64encode(f"admin:{PW}".encode()).decode())
    try:
        with urllib.request.urlopen(r, context=_ctx(), timeout=30) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def register():
    for name, method, endpoint, desc, props, required, body in TOOLS:
        tool_id = f"{APP}:{name}"
        execution = {"type": "api", "method": method, "endpoint": endpoint}
        if body is not None:
            execution["body"] = body
            # Force JSON so the MCP server sends a raw JSON body (not form-encoded);
            # our REST handler parses req['payload'] as JSON.
            execution["headers"] = {"Content-Type": "application/json"}
        doc = {
            "_key": tool_id, "tool_id": tool_id, "name": name, "title": name,
            "description": desc,
            "inputSchema": {"type": "object", "properties": props, "required": required},
            "_meta": {"tags": [APP], "execution": execution,
                      "external_app_id": APP, "required_app": APP},
        }
        # Upsert into mcp_tools.
        s, _ = _req("POST", f"{BASE}/mcp_tools/{tool_id}", doc)
        if s >= 400:
            s, _ = _req("POST", f"{BASE}/mcp_tools", doc)
        # Enable.
        en = {"_key": name, "tool_id": tool_id, "collision_ids": []}
        s2, _ = _req("POST", f"{BASE}/mcp_tools_enabled/{name}", en)
        if s2 >= 400:
            s2, _ = _req("POST", f"{BASE}/mcp_tools_enabled", en)
        print(f"  {name}: mcp_tools={s} enabled={s2}")


def remove():
    for name, *_ in TOOLS:
        tool_id = f"{APP}:{name}"
        _req("DELETE", f"{BASE}/mcp_tools/{tool_id}")
        _req("DELETE", f"{BASE}/mcp_tools_enabled/{name}")
        print(f"  removed {name}")


if __name__ == "__main__":
    if not PW:
        print("SPLUNK_PASSWORD not set", file=sys.stderr)
        sys.exit(1)
    (remove if "--remove" in sys.argv else register)()
    print("done.")
