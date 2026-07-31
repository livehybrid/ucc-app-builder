"""
UCC App Builder - NATIVE same-origin API handler for the embedded SPA.

The SPA's `/api/...` traffic is repointed by the page loader to
`/<locale>/splunkd/__raw/services/ucc_app_builder/api?p=/api/...` and lands here. This
handler implements those routes ENTIRELY in Splunk's python - ucc-gen + AppInspect builds,
the deterministic artifact generators, the LLM proxy, the input emulator, Splunk metadata -
so the app has NO Node sidecar dependency. (Replaces the old builder_proxy.py, which
forwarded to a Node build engine on localhost.)

Responses are buffered (a persistent REST handler can't stream), which the SPA's SSE
parsers tolerate.
"""
import importlib.util
import json
import os
import subprocess
import sys
import urllib.parse

from splunk.persistconn.application import PersistentServerConnectionApplication

_BIN = os.path.dirname(os.path.abspath(__file__))
_LIB = os.path.join(os.path.dirname(_BIN), "lib")
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)
if _BIN not in sys.path:
    sys.path.insert(0, _BIN)


def _load(mod):
    spec = importlib.util.spec_from_file_location(mod, os.path.join(_BIN, mod + ".py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


builder_common = _load("builder_common")
builder_llm = _load("builder_llm")
builder_generators = _load("builder_generators")
get_session_key = builder_common.get_session_key

APP = "ucc_app_builder"
_BUILDS_DIR = os.path.join(os.environ.get("SPLUNK_HOME", "/opt/splunk"),
                           "var", "run", APP, "builds")


# --------------------------------------------------------------------------- helpers
def _json(payload, status=200, headers=None):
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    return {"status": status, "payload": json.dumps(payload), "headers": h}


def _splunkd(session_key, path, method="GET", **kw):
    import splunk.rest as rest
    return rest.simpleRequest(path, sessionKey=session_key, method=method,
                              raiseAllErrors=False, **kw)


def _sub_path(req):
    """The original `/api/...` path+query, passed by the loader in the `p` query param."""
    for k, v in (req.get("query") or []):
        if k == "p" and v:
            return v
    for key in ("path_info", "rest_path", "path"):
        v = req.get(key)
        if isinstance(v, str) and "/api/" in v:
            return v[v.find("/api/"):]
    return "/api/health"


def _body(req):
    payload = req.get("payload")
    if isinstance(payload, (bytes, bytearray)):
        payload = payload.decode("utf-8", "replace")
    if isinstance(payload, str) and payload.strip():
        try:
            return json.loads(payload)
        except ValueError:
            return {}
    return {}


# --------------------------------------------------------------------------- build jobs
def _build_dir(build_id):
    safe = "".join(c for c in str(build_id) if c.isalnum() or c in "-_")
    return os.path.join(_BUILDS_DIR, safe)


def _run_build_job(body):
    """Synchronous build (ucc-gen + package) persisted under a build-id dir so the
    poll/download requests (possibly a different handler process) can read it."""
    import datetime
    import shutil
    import uuid
    builder_build = _load("builder_build")
    build_id = uuid.uuid4().hex
    bdir = _build_dir(build_id)
    os.makedirs(bdir, exist_ok=True)
    app_id = str(body.get("appId") or "app")
    files = body.get("files") or []
    version = "1.0.0"
    for f in files:
        if str(f.get("path", "")).endswith("globalConfig.json"):
            try:
                version = json.loads(f.get("content") or "{}").get("meta", {}).get("version") or version
            except ValueError:
                pass
            break
    status = {"id": build_id, "status": "running", "progress": 10, "logs": [],
              "appId": app_id, "startedAt": datetime.datetime.utcnow().isoformat() + "Z"}
    try:
        res = builder_build.build_and_inspect(files, app_id, version=version,
                                              do_package=True, include_warnings=False)
        if res.get("ok") is False:
            # ucc-gen / package failed - build_and_inspect now RETURNS the captured output
            # (it no longer raises), so surface it as a failed status with the real error.
            status.update({
                "status": "failed", "progress": 100,
                "error": res.get("error") or "build failed",
                "buildError": res.get("buildError"),
                "logs": res.get("trace") or [],
                "completedAt": datetime.datetime.utcnow().isoformat() + "Z",
            })
        else:
            tarball = res.get("tarball")
            out_path = None
            if tarball and os.path.isfile(tarball):
                out_path = os.path.join(bdir, "%s.tgz" % app_id)
                shutil.copyfile(tarball, out_path)
                shutil.rmtree(os.path.dirname(tarball), ignore_errors=True)
            status.update({
                "status": "success", "progress": 100,
                "logs": res.get("trace") or [],
                "outputPath": out_path,
                "clean": res.get("clean"), "summary": res.get("summary"),
                "completedAt": datetime.datetime.utcnow().isoformat() + "Z",
            })
    except Exception as e:  # noqa: BLE001
        status.update({"status": "failed", "progress": 100, "error": str(e),
                       "completedAt": datetime.datetime.utcnow().isoformat() + "Z"})
        existing = status.get("logs") or []
        existing.append("BUILD FAILED: %s" % e)
        status["logs"] = existing
    with open(os.path.join(bdir, "status.json"), "w", encoding="utf-8") as fh:
        json.dump(status, fh)
    return build_id, status


def _read_build_status(build_id):
    try:
        with open(os.path.join(_build_dir(build_id), "status.json"), "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


# --------------------------------------------------------------------------- emulate
def _emulate_input(body):
    harness = os.path.join(_BIN, "input_emulator.py")
    if not os.path.isfile(harness):
        return _json({"ok": False, "error": "input emulator harness missing"}, 500)
    payload = json.dumps({
        "helperCode": body.get("helperCode") or "",
        "args": body.get("args") or {},
        "index": body.get("index") or "main",
        "proxy": body.get("proxy"),
        "maxEvents": int(body.get("maxEvents") or 200),
    })
    if not body.get("helperCode"):
        return _json({"ok": False, "error": "helperCode is required"}, 400)
    try:
        proc = subprocess.run([sys.executable, harness], input=payload, capture_output=True,
                              text=True, timeout=45)
        out = (proc.stdout or "").strip()
        line = next((ln for ln in reversed(out.split("\n")) if ln.strip().startswith("{")), "{}")
        return _json(json.loads(line))
    except Exception as e:  # noqa: BLE001
        return _json({"ok": False, "error": str(e)}, 500)


# --------------------------------------------------------------------------- splunk metadata
def _splunk_indexes(session_key):
    try:
        _r, body = _splunkd(session_key, "/services/data/indexes?output_mode=json&count=0")
        entries = json.loads(body).get("entry", [])
        names = [e.get("name") for e in entries
                 if e.get("name") and not e.get("name", "").startswith("_")]
        return _json({"ok": True, "indexes": sorted(names)})
    except Exception as e:  # noqa: BLE001
        return _json({"ok": False, "error": str(e)}, 502)


def _splunk_sourcetypes(session_key, index):
    spl = "| metadata type=sourcetypes" + (" index=%s" % index if index else "") + " | sort - totalCount | fields sourcetype"
    try:
        _r, body = _splunkd(session_key, "/services/search/jobs/oneshot", method="POST",
                            postargs={"search": spl, "output_mode": "json", "count": "0",
                                      "earliest_time": "-24h", "latest_time": "now"})
        results = json.loads(body).get("results", [])
        sts = [r.get("sourcetype") for r in results if r.get("sourcetype")]
        return _json({"ok": True, "index": index, "sourcetypes": sts})
    except Exception as e:  # noqa: BLE001
        return _json({"ok": False, "error": str(e)}, 502)


# --------------------------------------------------------------------------- github oauth
def _github_config(session_key):
    cid = os.environ.get("GITHUB_CLIENT_ID") or ""
    return _json({"configured": bool(cid), "clientId": cid})


def _github_passthrough(path, body):
    import ssl
    import urllib.request
    url = {"device": "https://github.com/login/device/code",
           "token": "https://github.com/login/oauth/access_token"}.get(path)
    if not url:
        return _json({"error": "unknown github route"}, 404)
    data = urllib.parse.urlencode(body or {}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Accept": "application/json",
                                          "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30, context=ssl.create_default_context()) as resp:
            return _json(json.loads(resp.read().decode("utf-8")))
    except Exception as e:  # noqa: BLE001
        return _json({"error": str(e)}, 502)


# --------------------------------------------------------------------------- build loop (SSE)
def _build_loop(session_key, body):
    """Native agentic AppInspect loop: build -> inspect -> (LLM fix) -> repeat. Emitted as a
    single buffered SSE body (the SPA's runBuildLoop parser tolerates non-incremental)."""
    import datetime
    builder_build = _load("builder_build")
    app_id = str(body.get("appId") or "app")
    files = list(body.get("files") or [])
    version = str(body.get("version") or "1.0.0")
    max_iter = int(body.get("maxIterations") or 4)
    include_warnings = bool(body.get("includeWarnings"))
    use_llm = body.get("useLlm", True) and body.get("llmOnly", False) is not True
    _ai_cfg = builder_llm.read_ai_provider(session_key)
    fixer_model = (_ai_cfg.get("build_model") or _ai_cfg.get("model") or None)
    # Configuration → AI Provider "Build-loop temperature". Was previously dead config:
    # the fixer hard-coded 0.1 and never read it.
    fixer_temp = builder_llm.float_or_none(_ai_cfg.get("build_temperature"))
    if fixer_temp is None:
        fixer_temp = 0.1
    events = []
    blocks = []

    def emit(name, data):
        blocks.append("event: %s\ndata: %s\n\n" % (name, json.dumps(data)))

    def loop_event(kind, iteration, message, data=None):
        ev = {"kind": kind, "iteration": iteration,
              "ts": datetime.datetime.utcnow().isoformat() + "Z", "message": message}
        if data:
            ev["data"] = data
        events.append(ev)
        emit("loop", ev)

    clean = False
    iteration = 0
    loop_event("start", 0, "Starting build/inspect loop for %s" % app_id)
    try:
        for iteration in range(1, max_iter + 1):
            loop_event("build", iteration, "Building + inspecting (iteration %d)" % iteration)
            res = builder_build.build_and_inspect(files, app_id, version=version,
                                                  do_package=False, include_warnings=include_warnings)
            if res.get("ok") is False:
                # ucc-gen (or schema pre-validation) failed, so AppInspect never ran and
                # there is no `report`. Surface the ACTUAL error - previously this fell
                # through to _llm_fix, which found no `report.checks`, returned None, and
                # the loop stopped with a bare "No fix produced".
                detail = res.get("schemaErrors") or (res.get("buildError") or "").splitlines()
                loop_event("build_error", iteration,
                           res.get("error") or "Build failed before AppInspect",
                           {"errors": [d for d in detail if str(d).strip()][:12],
                            "schema": bool(res.get("schemaErrors"))})
            summary = res.get("summary") or {}
            blocking = res.get("blocking") or []
            adv = res.get("advisories") or {}
            if res.get("ok") is not False:
                loop_event("inspect", iteration, "AppInspect: %s" % json.dumps(summary),
                           {"summary": summary, "blocking": blocking, "advisories": adv})
            if res.get("clean"):
                clean = True
                # future_failure / warning are advisory - report them but they do NOT fail
                # the build (no actual failures or errors).
                fut, warn = adv.get("future_failure", 0), adv.get("warning", 0)
                msg = "No AppInspect failures or errors - build is clean."
                if fut or warn:
                    msg += (" Advisory only (does not block packaging): %d future-failure(s) "
                            "and %d warning(s) - review before a future Splunk release." % (fut, warn))
                loop_event("clean", iteration, msg, {"advisories": adv})
                break
            if not use_llm:
                loop_event("fix_skipped", iteration, "LLM fixing disabled; stopping.")
                break
            # Ask the configured build model to patch the source for the blocking checks.
            patched = _llm_fix(session_key, files, app_id, res, fixer_model, fixer_temp)
            if not patched:
                loop_event("fix_skipped", iteration, "No fix produced; stopping.")
                break
            files = patched
            loop_event("fix", iteration, "Applied LLM fix; rebuilding.")
        else:
            loop_event("exhausted", iteration, "Reached max iterations without a clean result.")
    except Exception as e:  # noqa: BLE001
        emit("error", {"error": str(e)})
        return {"status": 200, "payload": "".join(blocks),
                "headers": {"Content-Type": "text/event-stream", "Cache-Control": "no-cache"}}

    loop_event("done", iteration, "Loop complete (clean=%s)" % clean)
    result = {"ok": True, "clean": clean, "iterations": iteration, "appId": app_id,
              "files": files, "events": events,
              "finalSummary": "clean" if clean else "unresolved AppInspect findings"}
    emit("result", result)
    return {"status": 200, "payload": "".join(blocks),
            "headers": {"Content-Type": "text/event-stream", "Cache-Control": "no-cache"}}


def _llm_fix(session_key, files, app_id, build_result, model, temperature=0.1):
    """Single-shot LLM patch: hand the model the blocking checks + current source and ask
    for full-file replacements as JSON {path, content}[]. Returns updated files or None."""
    # A build FAILURE has no AppInspect report - the actionable detail is the schema errors
    # (path-anchored, naming the offending property) or ucc-gen's stderr tail. Feed those in
    # as synthetic findings so the fixer gets a repair attempt instead of the loop stopping.
    if build_result.get("ok") is False:
        detail = build_result.get("schemaErrors") or []
        if not detail:
            detail = [ln for ln in (build_result.get("buildError") or "").splitlines()
                      if ln.strip()][-15:]
        if not detail:
            return None
        blocking = [{"check": "globalConfig_schema" if build_result.get("schemaErrors")
                     else "ucc_gen_build_error",
                     "result": "failure", "message": str(d)} for d in detail]
    else:
        blocking = build_result.get("report", {}).get("checks") or []
    fails = [c for c in blocking if (c.get("result") or "").lower() in ("failure", "error")][:12]
    if not fails:
        return None
    src = "\n".join("=== %s ===\n%s" % (f.get("path"), (f.get("content") or "")[:4000])
                    for f in files if str(f.get("path", "")).endswith((".json", ".conf", ".py", ".manifest")))[:24000]
    findings = "\n".join("- %s: %s" % (c.get("check"), c.get("message")) for c in fails)
    prompt = (
        "You are fixing a Splunk UCC add-on so it passes AppInspect. Blocking findings:\n%s\n\n"
        "Current source files:\n%s\n\n"
        "Return ONLY a JSON array of the files you changed, each {\"path\":..., \"content\": <full new file>}. "
        "Use the SAME paths as above. No prose." % (findings, src))
    text, err = builder_llm.complete_text(session_key, [{"role": "user", "content": prompt}],
                                          model=model, temperature=temperature, max_tokens=8000)
    if err or not text:
        return None
    try:
        start, end = text.find("["), text.rfind("]")
        patches = json.loads(text[start:end + 1]) if start >= 0 and end > start else None
    except ValueError:
        patches = None
    if not isinstance(patches, list):
        return None
    by_path = {f.get("path"): f for f in files}
    for p in patches:
        path = p.get("path")
        if path and path in by_path and isinstance(p.get("content"), str):
            by_path[path]["content"] = p["content"]
    return list(by_path.values())


# --------------------------------------------------------------------------- router
class BuilderApiHandler(PersistentServerConnectionApplication):
    def __init__(self, command_line=None, command_arg=None):
        super(BuilderApiHandler, self).__init__()

    def handle(self, in_string):
        try:
            req = json.loads(in_string) if in_string else {}
            session_key = get_session_key(req)
            if not session_key:
                return _json({"error": "Missing session key"}, 401)
            method = (req.get("method") or "GET").upper()
            raw = _sub_path(req)
            parsed = urllib.parse.urlparse(raw)
            path = parsed.path
            query = dict(urllib.parse.parse_qsl(parsed.query))
            return self._route(session_key, method, path, query, req)
        except Exception as e:  # noqa: BLE001
            return _json({"error": "api error: %s" % e}, 500)

    def _route(self, sk, method, path, query, req):
        # --- health / version / validate ---
        if path == "/api/health":
            return _json({"status": "ok", "native": True})
        if path == "/api/ucc-version":
            builder_build = _load("builder_build")
            return _json(builder_build.ucc_version())
        if path == "/api/validate" and method == "POST":
            builder_build = _load("builder_build")
            return _json(builder_build.validate_config(_body(req).get("globalConfig") or {}))
        # The AUTHORITATIVE globalConfig schema from the installed ucc-framework. The editor
        # falls back to a small bundled subset without this, which greenlights configs
        # ucc-gen then rejects (it omits the oneOf/additionalProperties constraints).
        if path == "/api/ucc/schema":
            builder_schema = _load("builder_schema")
            schema = builder_schema.load_schema()
            if schema is None:
                return _json({"error": "ucc-framework schema not available"}, 404)
            return _json({"schema": schema, "uccVersion": builder_schema.ucc_version()})
        # Schema-only globalConfig check (no ucc-gen run) - same validator the build uses.
        if path == "/api/ucc/validate" and method == "POST":
            builder_schema = _load("builder_schema")
            body = _body(req)
            gc = body.get("globalConfig")
            if isinstance(gc, str):
                return _json(builder_schema.validate_global_config_text(gc))
            return _json(builder_schema.validate_global_config(gc or {}))

        # --- build (sync job + poll + download) ---
        if path == "/api/build" and method == "POST":
            body = _body(req)
            if not isinstance(body.get("files"), list) or not body.get("appId"):
                return _json({"error": "files[] and appId are required"}, 400)
            build_id, _status = _run_build_job(body)
            return _json({"buildId": build_id, "status": "running"})
        if path.startswith("/api/build/"):
            rest_part = path[len("/api/build/"):]
            if rest_part.endswith("/download"):
                build_id = rest_part[:-len("/download")]
                st = _read_build_status(build_id)
                if not st:
                    return _json({"error": "Build not found"}, 404)
                if st.get("status") != "success" or not st.get("outputPath"):
                    return _json({"error": "Build not complete or failed"}, 400)
                try:
                    import base64
                    with open(st["outputPath"], "rb") as fh:
                        data = fh.read()
                    # A persistent REST handler can't return a raw `bytes` payload (splunkd
                    # JSON-serializes the reply and drops it). Hand the SPA base64 + the
                    # filename; downloadBuild() reconstructs the blob client-side.
                    return _json({"ok": True, "filename": "%s.tgz" % (st.get("appId") or "app"),
                                  "encoding": "base64",
                                  "base64": base64.b64encode(data).decode("ascii")})
                except Exception as e:  # noqa: BLE001
                    return _json({"error": "download failed: %s" % e}, 500)
            st = _read_build_status(rest_part)
            return _json(st) if st else _json({"error": "Build not found"}, 404)

        # --- AI: config / models / chat ---
        if path == "/api/ai/config":
            return _json(builder_llm.ai_config_response(sk))
        if path == "/api/ai/models":
            return _json(builder_llm.list_models(sk, query.get("provider")))
        if path == "/api/ai/chat" and method == "POST":
            status, payload = builder_llm.chat_passthrough(sk, _body(req))
            return _json(payload, status)

        # --- deterministic generators ---
        if path == "/api/generate/dashboard" and method == "POST":
            b = _body(req)
            try:
                xml = builder_generators.build_dashboard_view_xml(b)
                return _json({"ok": True, "path": "package/default/data/ui/views/%s"
                              % builder_generators.view_file_name(b.get("title")),
                              "fileName": builder_generators.view_file_name(b.get("title")),
                              "content": xml})
            except Exception as e:  # noqa: BLE001
                return _json({"ok": False, "error": str(e)}, 400)
        if path == "/api/generate/savedsearch" and method == "POST":
            try:
                return _json({"ok": True, "stanza": builder_generators.build_savedsearch_stanza(_body(req))})
            except Exception as e:  # noqa: BLE001
                return _json({"ok": False, "error": str(e)}, 400)
        if path == "/api/generate/tests" and method == "POST":
            try:
                return _json({"ok": True, **builder_generators.build_pytest_scaffold(_body(req))})
            except Exception as e:  # noqa: BLE001
                return _json({"ok": False, "error": str(e)}, 400)

        # --- input emulator ---
        if path == "/api/emulate/input" and method == "POST":
            return _emulate_input(_body(req))

        # --- agentic build loop (SSE) ---
        if path == "/api/agent/build-loop" and method == "POST":
            return _build_loop(sk, _body(req))

        # --- Splunk metadata + SPL ---
        if path == "/api/splunk/indexes":
            return _splunk_indexes(sk)
        if path == "/api/splunk/sourcetypes":
            return _splunk_sourcetypes(sk, query.get("index"))
        if path == "/api/splunk/generate-spl" and method == "POST":
            q = str(_body(req).get("question") or "").strip()
            if not q:
                return _json({"ok": False, "error": "question is required"}, 400)
            text, err = builder_llm.complete_text(
                sk, [{"role": "user", "content":
                      "Write a single Splunk SPL search for: %s\nReturn only the SPL." % q}],
                temperature=0.2, max_tokens=512)
            if err:
                return _json({"ok": False, "error": err}, 502)
            return _json({"ok": True, "spl": text.strip()})

        # --- github oauth proxy ---
        if path == "/api/github/config":
            return _github_config(sk)
        if path == "/api/github/device/code" and method == "POST":
            return _github_passthrough("device", _body(req))
        if path == "/api/github/login/oauth/access_token" and method == "POST":
            return _github_passthrough("token", _body(req))

        return _json({"error": "no native handler for %s %s" % (method, path)}, 404)
