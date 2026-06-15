"""
UCC App Builder — Splunk Agent SDK (splunklib.ai) tool registry.

The in-app "App Builder Advisor" agent (builder_advisor.py) authors a UCC add-on
by calling these tools. They are the SAME operations exposed over MCP
(builder_tools.py), so the advisor and the Splunk MCP Server share one engine.

Tools are tagged `ucc_builder` so the agent's ToolAllowlist exposes exactly them.
Each reuses builder_common (KV-backed, path-confined project) — no traversal, no
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
sidecar_call = builder_common.sidecar_call
APP = "ucc_app_builder"

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
    # username from the session and key the KV project by it — so the in-app UI
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
    trace + summary; when clean is true, STOP — do not keep re-writing for warnings."""
    store = _store(ctx)
    files = store.dump()
    if not files:
        _dbg("build_and_inspect", error="empty project")
        return {"error": "project is empty — author globalConfig.json first"}
    _dbg("build_and_inspect", phase="start", appId=store.app_id(), n=len(files), warn=include_warnings)
    sk = _session_key(ctx)
    payload = {
        "appId": store.app_id(), "version": store.version(), "files": files,
        "maxIterations": max_iterations, "includeWarnings": bool(include_warnings),
    }
    fixer = _build_model(sk)
    if fixer:
        payload["fixerModel"] = fixer
    result, err = sidecar_call("/api/mcp/build_engine", payload, sk)
    if err:
        _dbg("build_and_inspect", error=str(err))
        return {"error": f"build engine unavailable: {err}"}
    _dbg("build_and_inspect", phase="done", clean=result.get("clean"), iterations=result.get("iterations"))
    for f in (result.get("files") or []):
        safe = to_safe_project_path(store.app_id(), f.get("path", ""))
        if safe is not None:
            store.write(safe, f.get("content", ""))
    return {"clean": result.get("clean"), "iterations": result.get("iterations"),
            "summary": result.get("summary"), "trace": result.get("trace")}
