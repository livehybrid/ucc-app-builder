#!/usr/bin/env python3
"""
Register the UCC App Builder's tools into the Splunk MCP Server so the Splunk AI
Assistant (and any MCP client) can call them. Mirrors how the Data Dictionary
registers, but as API-execution tools that proxy to this app's REST endpoints.

Two KV collections in Splunk_MCP_Server must both have the tool:
  - mcp_tools          : the tool definition (name, schema, _meta.execution=api)
  - mcp_tools_enabled  : { _key: <advertised name>, tool_id, collision_ids: [] }

The enabled _key is the name the MCP Server ADVERTISES, not the raw name: the
server prefixes every tool with _meta.name_prefix (default _meta.external_app_id)
unless the name already starts with it, then resolves tools/call by that name. Our
names already start with "ucc_", so name_prefix="ucc" keeps them as-is and avoids
the "ucc_app_builder_ucc_ping" stutter that tools/call would then reject (-32004).

TOOLS is the single source of truth: `--emit <path>` writes the same definitions to
the signatures file that the in-app bin/autoregister.py registers from on install,
so the manual and automatic paths cannot drift.

Usage:  python3 register_mcp_tools.py            # register/enable all tools
        python3 register_mcp_tools.py --remove   # deregister (cleanup)
        python3 register_mcp_tools.py --emit P   # write signatures JSON to P
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
NAME_PREFIX = "ucc"
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
     "Read one project file back by path (globalConfig.json, package/bin/<input>.py, ...). "
     "The counterpart to ucc_write_file; confined to the same project subtree.",
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
    ("ucc_generate_dashboard", "POST", "/services/ucc_app_builder/generate_dashboard",
     "Generate a Dashboard Studio (v2) dashboard. Provide title + panels[] where each panel is "
     "{title, spl, viz}; viz is one of line, area, column, bar, table, single, pie, scatter, map. "
     "Ground SPL in real indexes/sourcetypes. Use timechart+line for trends, stats/top+bar/column/"
     "table for breakdowns, single for KPIs. Written to default/data/ui/views/<name>.xml.",
     {"title": {"type": "string", "description": "Dashboard title."},
      "description": {"type": "string"},
      "panels": {"type": "array", "description": "Panels: [{title, spl, viz}].",
                 "items": {"type": "object",
                           "properties": {"title": {"type": "string"}, "spl": {"type": "string"},
                                          "viz": {"type": "string"}}}},
      "theme": {"type": "string", "description": "light or dark (default dark)."}},
     ["title", "panels"],
     {"title": "$title$", "description": "$description$", "panels": "$panels$", "theme": "$theme$"}),
    ("ucc_generate_savedsearch", "POST", "/services/ucc_app_builder/generate_savedsearch",
     "Generate a savedsearches.conf entry — a report or scheduled alert. Provide name + search (SPL). "
     "Optional: description, earliest, latest, cronSchedule (schedules it), and alert={condition "
     "(greater than|less than|equal to), threshold, severity 1-6} for alerting. Ground SPL in real "
     "indexes/sourcetypes. Appends to default/savedsearches.conf.",
     {"name": {"type": "string"}, "search": {"type": "string", "description": "SPL."},
      "description": {"type": "string"}, "cronSchedule": {"type": "string"},
      "earliest": {"type": "string"}, "latest": {"type": "string"},
      "alert": {"type": "object", "description": "{condition, threshold, severity}"}},
     ["name", "search"],
     {"name": "$name$", "search": "$search$", "description": "$description$",
      "cronSchedule": "$cronSchedule$", "earliest": "$earliest$", "latest": "$latest$",
      "alert": "$alert$"}),
    ("ucc_generate_tests", "POST", "/services/ucc_app_builder/generate_tests",
     "Generate a pytest-splunk-addon test scaffold to validate the add-on's knowledge objects "
     "(sourcetype/source/index assignment, props.conf/transforms.conf field extractions, and CIM "
     "data-model compliance). Provide sourcetypes[] = [{sourcetype, source?, index?, inputType? "
     "(modinput|scripted_input|file_monitor|uf_file_monitor|syslog_tcp), cimDataModels?[], "
     "sampleEvents?[] (raw events captured from the input emulator)}]. Writes tests/ "
     "(pytest.ini, requirements.txt, test_<addon>.py, data/pytest-splunk-addon-data.conf, "
     "data/samples/*.sample, README.md). Use after authoring props/transforms to prove them.",
     {"sourcetypes": {"type": "array", "description": "Sourcetypes to validate.",
                      "items": {"type": "object",
                                "properties": {"sourcetype": {"type": "string"},
                                               "source": {"type": "string"},
                                               "index": {"type": "string"},
                                               "inputType": {"type": "string"},
                                               "cimDataModels": {"type": "array",
                                                                 "items": {"type": "string"}},
                                               "sampleEvents": {"type": "array",
                                                                "items": {"type": "string"}}}}}},
     ["sourcetypes"],
     {"sourcetypes": "$sourcetypes$"}),
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


def mcp_name(name, prefix=NAME_PREFIX):
    """The name the MCP Server advertises, and the mcp_tools_enabled _key it resolves
    tools/call by. Mirrors Tool._convert_from_new_schema in the MCP Server."""
    prefix = (prefix or "").strip()
    if prefix and not name.startswith(prefix + "_"):
        return f"{prefix}_{name}"
    return name


def tool_doc(name, method, endpoint, desc, props, required, body):
    tool_id = f"{APP}:{name}"
    execution = {"type": "api", "method": method, "endpoint": endpoint}
    if body is not None:
        execution["body"] = body
        # Force JSON so the MCP server sends a raw JSON body (not form-encoded);
        # our REST handler parses req['payload'] as JSON.
        execution["headers"] = {"Content-Type": "application/json"}
    return {
        "_key": tool_id, "tool_id": tool_id, "name": name, "title": name,
        "description": desc,
        "inputSchema": {"type": "object", "properties": props, "required": required},
        "_meta": {"tags": [APP], "execution": execution,
                  "external_app_id": APP, "name_prefix": NAME_PREFIX,
                  "required_app": APP},
    }


def emit(path):
    """Write TOOLS to the signatures file bin/autoregister.py registers from."""
    docs = [tool_doc(*t) for t in TOOLS]
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(json.dumps(docs, indent=2) + "\n")
    print(f"  wrote {len(docs)} tool signatures -> {path}")


def register():
    for tool in TOOLS:
        doc = tool_doc(*tool)
        tool_id = doc["tool_id"]
        name = mcp_name(doc["name"])
        # Upsert into mcp_tools.
        s, _ = _req("POST", f"{BASE}/mcp_tools/{tool_id}", doc)
        if s >= 400:
            s, _ = _req("POST", f"{BASE}/mcp_tools", doc)
        # Enable under the ADVERTISED name (see module docstring).
        en = {"_key": name, "tool_id": tool_id, "collision_ids": []}
        s2, _ = _req("POST", f"{BASE}/mcp_tools_enabled/{name}", en)
        if s2 >= 400:
            s2, _ = _req("POST", f"{BASE}/mcp_tools_enabled", en)
        print(f"  {name}: mcp_tools={s} enabled={s2}")


def remove():
    for name, *_ in TOOLS:
        tool_id = f"{APP}:{name}"
        _req("DELETE", f"{BASE}/mcp_tools/{tool_id}")
        _req("DELETE", f"{BASE}/mcp_tools_enabled/{mcp_name(name)}")
        print(f"  removed {name}")


if __name__ == "__main__":
    # --emit is offline (build step): no Splunk, no password needed.
    if "--emit" in sys.argv:
        emit(sys.argv[sys.argv.index("--emit") + 1])
        print("done.")
        sys.exit(0)
    if not PW:
        print("SPLUNK_PASSWORD not set", file=sys.stderr)
        sys.exit(1)
    (remove if "--remove" in sys.argv else register)()
    print("done.")
