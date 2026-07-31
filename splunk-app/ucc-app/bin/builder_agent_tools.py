"""
UCC App Builder - Splunk Agent SDK (splunklib.ai) tool registry.

The in-app "App Builder Advisor" agent (builder_advisor.py) authors a UCC add-on
by calling these tools. They are the SAME operations exposed over MCP
(builder_tools.py), so the advisor and the Splunk MCP Server share one engine.

Tools are tagged `ucc_builder` so the agent's ToolAllowlist exposes exactly them.
Each reuses builder_common (KV-backed, path-confined project) - no traversal, no
host access. Requires Python 3.13 (splunklib.ai); runs inside the Splunk app.
"""
import importlib.util
import os
import sys

_LIB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib")
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

from splunklib.ai.registry import ToolRegistry, ToolContext

_bin = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("builder_common", os.path.join(_bin, "builder_common.py"))
builder_common = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(builder_common)
KV = builder_common.KVProjectStore
to_safe_project_path = builder_common.to_safe_project_path
derive_app_id = builder_common.derive_app_id
APP = "ucc_app_builder"


def _load_sibling(mod):
    s = importlib.util.spec_from_file_location(mod, os.path.join(_bin, mod + ".py"))
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


# Native, in-Splunk implementations (no Node sidecar).
builder_generators = _load_sibling("builder_generators")

registry = ToolRegistry()

_DEBUG_LOG = os.environ.get("UCC_ADVISOR_TOOL_LOG", "/tmp/ucc_advisor_dbg.log")


def _dbg(tool, **kv):
    try:
        import json as _json
        import time as _time
        with open(_DEBUG_LOG, "a") as fh:
            fh.write(_json.dumps({"t": round(_time.time(), 2), "tool": tool, **kv})[:2000] + "\n")
        try:
            os.chmod(_DEBUG_LOG, 0o666)
        except OSError:
            pass
    except Exception:
        pass


def _session_key(ctx: ToolContext) -> str:
    # ToolContext carries the Splunk service/session. The parent builds the service
    # with token="Splunk <sk>"; splunk.rest adds its own "Splunk " prefix, so strip
    # it here to avoid a double prefix (-> HTTP 401) when used as a sessionKey.
    sk = getattr(ctx, "session_key", None) or getattr(getattr(ctx, "service", None), "token", None) or ""
    if isinstance(sk, str) and sk.startswith("Splunk "):
        sk = sk[len("Splunk "):]
    return sk


_USERNAME_CACHE = {}


def _username(ctx: ToolContext) -> str:
    # ToolContext exposes only .service (no user), so resolve the authenticated
    # username from the session and key the KV project by it - so the in-app UI
    # (builder_tools.py, keyed by req session user) and the agent share ONE project.
    # Cached per token for the life of this (subprocess) agent run.
    svc = getattr(ctx, "service", None)
    tok = getattr(svc, "token", "") or ""
    if tok in _USERNAME_CACHE:
        return _USERNAME_CACHE[tok]
    user = "advisor"
    try:
        import json as _json
        resp = svc.get("/services/authentication/current-context", output_mode="json")
        body = resp["body"].read()
        if isinstance(body, bytes):
            body = body.decode("utf-8", "replace")
        entry = _json.loads(body).get("entry", [])
        if entry:
            user = entry[0].get("content", {}).get("username") or "advisor"
    except Exception:
        pass
    _USERNAME_CACHE[tok] = user
    return user


def _store(ctx: ToolContext) -> "builder_common.KVProjectStore":
    return KV(_session_key(ctx), app=APP, user=_username(ctx))


def _build_model(session_key: str) -> str:
    """The build-loop fixer model from the Configuration → AI Provider tab (build_model)."""
    try:
        import json as _json
        import splunk.rest as rest
        _, body = rest.simpleRequest(
            f"/servicesNS/nobody/{APP}/configs/conf-ucc_app_builder_settings/ai_provider?output_mode=json",
            sessionKey=session_key, method="GET", raiseAllErrors=False)
        entry = _json.loads(body).get("entry", [])
        if entry:
            return entry[0].get("content", {}).get("build_model") or ""
    except Exception:
        pass
    return ""


@registry.tool(name="create_addon", tags=["ucc_builder"])
def create_addon(ctx: ToolContext, name: str, version: str = "1.0.0") -> dict:
    """Start (or reset) a UCC add-on project. appId is derived (TA_<name>). Call first."""
    app_id = derive_app_id(name)
    _store(ctx).reset(app_id, version)
    _dbg("create_addon", name=name, appId=app_id)
    return {"appId": app_id, "next": "write_file globalConfig.json, then build_and_inspect"}


@registry.tool(name="write_file", tags=["ucc_builder"])
def write_file(ctx: ToolContext, path: str, content: str) -> dict:
    """Author/overwrite a project file (globalConfig.json, package/bin/<input>.py, ...)."""
    store = _store(ctx)
    safe = to_safe_project_path(store.app_id(), path)
    if safe is None:
        return {"error": f'path "{path}" rejected (no absolute paths or ".." traversal)'}
    store.write(safe, content)
    _dbg("write_file", path=safe, bytes=len(content or ""))
    return {"ok": True, "path": safe}


@registry.tool(name="read_file", tags=["ucc_builder"])
def read_file(ctx: ToolContext, path: str) -> dict:
    """Read one project file back."""
    store = _store(ctx)
    safe = to_safe_project_path(store.app_id(), path)
    if safe is None:
        return {"error": "path rejected"}
    content = store.read(safe)
    _dbg("read_file", path=safe, found=content is not None)
    return {"found": content is not None, "content": content}


@registry.tool(name="list_project", tags=["ucc_builder"])
def list_project(ctx: ToolContext) -> dict:
    """List the files currently in the add-on project."""
    store = _store(ctx)
    files = store.list_paths()
    _dbg("list_project", appId=store.app_id(), n=len(files))
    return {"appId": store.app_id(), "files": files}


@registry.tool(name="build_and_inspect", tags=["ucc_builder"])
def build_and_inspect(ctx: ToolContext, max_iterations: int = 4, include_warnings: bool = False) -> dict:
    """Run ucc-gen build -> AppInspect -> auto-fix until clean. `clean: true` means no
    AppInspect FAILURES (the packaging gate). AppInspect WARNINGS are advisory and do
    NOT block packaging; set include_warnings=True only to also surface them. Returns
    trace + summary; when clean is true, STOP - do not keep re-writing for warnings."""
    store = _store(ctx)
    files = store.dump()
    if not files:
        _dbg("build_and_inspect", error="empty project")
        return {"error": "project is empty - author globalConfig.json first"}
    _dbg("build_and_inspect", phase="start", appId=store.app_id(), n=len(files), warn=include_warnings)
    builder_build = _load_sibling("builder_build")
    try:
        result = builder_build.build_and_inspect(
            files, store.app_id(), version=store.version() or "1.0.0",
            do_package=False, include_warnings=bool(include_warnings))
    except Exception as e:  # noqa: BLE001
        _dbg("build_and_inspect", error=str(e))
        return {"error": f"build failed: {e}"}
    _dbg("build_and_inspect", phase="done", clean=result.get("clean"),
         ok=result.get("ok"), iterations=result.get("iterations"))
    for f in (result.get("files") or []):
        safe = to_safe_project_path(store.app_id(), f.get("path", ""))
        if safe is not None:
            store.write(safe, f.get("content", ""))
    # On a build FAILURE, surface ucc-gen's actual error output so the agent can fix the
    # add-on (not just see "build failed with code 1"). buildError is the stderr tail.
    if result.get("ok") is False:
        out = {"clean": False, "error": result.get("error"),
               "buildError": result.get("buildError"), "trace": result.get("trace")}
        # Schema failures carry path-anchored, actionable errors - hand them over verbatim
        # and tell the agent to fix exactly those rather than restructure blindly.
        if result.get("schemaErrors"):
            out["schemaErrors"] = result["schemaErrors"]
            out["hint"] = ("globalConfig.json does not match the UCC schema. Fix EXACTLY the "
                           "paths listed in schemaErrors - each one names the offending "
                           "property and what is allowed there. Do NOT restructure anything "
                           "that was not flagged. Call ucc_schema_help for a definition's "
                           "full shape if you need it.")
        return out
    return {"clean": result.get("clean"), "iterations": result.get("iterations"),
            "summary": result.get("summary"), "blocking": result.get("blocking"),
            "trace": result.get("trace")}


@registry.tool(name="validate_global_config", tags=["ucc_builder"])
def validate_global_config(ctx: ToolContext) -> dict:
    """Check the project's globalConfig.json against the real ucc-framework JSON Schema
    WITHOUT running a build. Fast (no ucc-gen), and it reports every problem with its JSON
    path plus the properties that ARE allowed there - unlike ucc-gen, which reports one
    misleading message for a `oneOf` node. Call this after writing globalConfig.json and
    before build_and_inspect."""
    store = _store(ctx)
    content = store.read(to_safe_project_path(store.app_id(), "globalConfig.json") or "")
    if content is None:
        return {"ok": False, "errors": ["globalConfig.json not found in the project"]}
    try:
        builder_schema = _load_sibling("builder_schema")
        res = builder_schema.validate_global_config_text(content)
    except Exception as e:  # noqa: BLE001
        return {"ok": True, "checked": False, "note": f"validation unavailable: {e}"}
    _dbg("validate_global_config", ok=res.get("ok"), n=len(res.get("errors") or []))
    return res


@registry.tool(name="ucc_schema_help", tags=["ucc_builder"])
def ucc_schema_help(ctx: ToolContext, name: str = "") -> dict:
    """Return one named definition from the ucc-framework globalConfig JSON Schema (e.g.
    'InputsPage', 'ConfigurationPage', 'Entity', 'NumberValidator'), with its oneOf/anyOf
    branches expanded. Call with no name to list every definition. Use this instead of
    guessing when a schema error is unclear."""
    try:
        builder_schema = _load_sibling("builder_schema")
        return builder_schema.schema_help(name or None)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"schema help unavailable: {e}"}


@registry.tool(name="generate_dashboard", tags=["ucc_builder"])
def generate_dashboard(ctx: ToolContext, title: str, panels: list, description: str = "",
                       theme: str = "dark") -> dict:
    """Generate a DASHBOARD as a Dashboard Studio (v2) view and write it into the project -
    do NOT hand-author Simple XML. `panels` is a list of {title, spl, viz} where viz is one
    of line, area, column, bar, table, single, pie, scatter, map. Ground SPL in real
    indexes/sourcetypes. Writes default/data/ui/views/<name>.xml."""
    store = _store(ctx)
    if not store.app_id():
        return {"error": "no project loaded - author globalConfig.json first"}
    if not title or not panels:
        return {"error": "title and a non-empty panels list are required"}
    try:
        content = builder_generators.build_dashboard_view_xml(
            {"title": title, "description": description, "panels": panels, "theme": theme})
        file_name = builder_generators.view_file_name(title)
    except Exception as e:  # noqa: BLE001
        return {"error": f"dashboard generation failed: {e}"}
    safe = to_safe_project_path(store.app_id(), "package/default/data/ui/views/%s" % file_name)
    if safe:
        store.write(safe, content)
    _dbg("generate_dashboard", path=safe)
    return {"ok": True, "path": safe, "fileName": file_name}


@registry.tool(name="generate_savedsearch", tags=["ucc_builder"])
def generate_savedsearch(ctx: ToolContext, name: str, search: str, description: str = "",
                         cron_schedule: str = "", earliest: str = "", latest: str = "",
                         alert: dict = None) -> dict:
    """Generate a savedsearches.conf entry (report or scheduled alert) and append it to the
    project. Provide name + search (SPL); optional cron_schedule (schedules it) and
    alert={condition (greater than|less than|equal to), threshold, severity 1-6}."""
    store = _store(ctx)
    if not store.app_id():
        return {"error": "no project loaded - author globalConfig.json first"}
    spec = {"name": name, "search": search, "description": description,
            "cronSchedule": cron_schedule, "earliest": earliest, "latest": latest}
    if alert:
        spec["alert"] = alert
    try:
        stanza = builder_generators.build_savedsearch_stanza(spec)
    except Exception as e:  # noqa: BLE001
        return {"error": f"savedsearch generation failed: {e}"}
    safe = to_safe_project_path(store.app_id(), "package/default/savedsearches.conf")
    existing = (store.read(safe) or "") if safe else ""
    content = (existing.rstrip() + "\n\n" + stanza) if existing.strip() else stanza
    if safe:
        store.write(safe, content)
    _dbg("generate_savedsearch", name=name)
    return {"ok": True, "path": safe}


@registry.tool(name="generate_tests", tags=["ucc_builder"])
def generate_tests(ctx: ToolContext, sourcetypes: list) -> dict:
    """Generate a pytest-splunk-addon test scaffold (props/transforms/CIM validation) for the
    project's sourcetypes and write it under tests/. `sourcetypes` is a list of {sourcetype,
    source?, index?, cimDataModels?, sampleEvents?}."""
    store = _store(ctx)
    if not store.app_id():
        return {"error": "no project loaded - author globalConfig.json first"}
    try:
        scaffold = builder_generators.build_pytest_scaffold(
            {"addonName": store.app_id(), "sourcetypes": sourcetypes})
    except Exception as e:  # noqa: BLE001
        return {"error": f"test generation failed: {e}"}
    written = []
    for f in (scaffold.get("files") or []):
        safe = to_safe_project_path(store.app_id(), str(f.get("path") or ""))
        if safe:
            store.write(safe, str(f.get("content") or ""))
            written.append(safe)
    _dbg("generate_tests", n=len(written))
    return {"ok": True, "files": written}
