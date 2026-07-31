#!/usr/bin/env python3
"""
Live integration smoke test for the native Splunk app (ucc_app_builder), run against a
real Splunk instance (in CI: a Splunk Docker container; locally: any instance).

Exercises the MCP tool REST handlers + AI-config endpoints end-to-end through splunkd,
exactly as the Splunk MCP Server and the in-app UI call them. EVERY check asserts and
the script exits non-zero on the first failure (no silent passes), printing a summary.

Env:
  SPLUNK_HOST (default 127.0.0.1), SPLUNK_PORT (default 8089),
  SPLUNK_USER (default admin), SPLUNK_PASSWORD (required).
"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

HOST = os.environ.get("SPLUNK_HOST", "127.0.0.1")
PORT = os.environ.get("SPLUNK_PORT", "8089")
USER = os.environ.get("SPLUNK_USER", "admin")
PW = os.environ.get("SPLUNK_PASSWORD", "")
BASE = f"https://{HOST}:{PORT}"
APP = "ucc_app_builder"
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

_passed = 0


def _login():
    data = urllib.parse.urlencode({"username": USER, "password": PW, "output_mode": "json"}).encode()
    r = urllib.request.urlopen(urllib.request.Request(f"{BASE}/services/auth/login", data=data), context=CTX, timeout=30)
    return json.loads(r.read())["sessionKey"]


def _wait_kvstore(sk, attempts=30, delay=5):
    """The app's tools are KV-backed; on a fresh instance the KV store (mongod) can lag
    behind splunkd readiness. Wait until it reports ready before exercising the tools."""
    import time
    req = urllib.request.Request(f"{BASE}/services/kvstore/status?output_mode=json")
    req.add_header("Authorization", "Splunk " + sk)
    for i in range(attempts):
        try:
            body = urllib.request.urlopen(req, context=CTX, timeout=15).read()
            st = json.loads(body)["entry"][0]["content"].get("current", {}).get("status")
            if st == "ready":
                print(f"KV store ready (after ~{i * delay}s)")
                return
            print(f"  kvstore status={st} … waiting")
        except Exception as e:
            print(f"  kvstore check error: {e}")
        time.sleep(delay)
    print("WARNING: KV store not confirmed ready; proceeding anyway")


def _call(sk, endpoint, body):
    req = urllib.request.Request(f"{BASE}/services/{APP}/{endpoint}", data=json.dumps(body).encode(), method="POST")
    req.add_header("Authorization", "Splunk " + sk)
    req.add_header("Content-Type", "application/json")
    try:
        return json.loads(urllib.request.urlopen(req, context=CTX, timeout=60).read())
    except urllib.error.HTTPError as e:
        return {"_http_error": e.code, "_body": e.read().decode()[:300]}


def _get(sk, endpoint):
    req = urllib.request.Request(f"{BASE}/services/{APP}/{endpoint}?output_mode=json", method="GET")
    req.add_header("Authorization", "Splunk " + sk)
    try:
        return json.loads(urllib.request.urlopen(req, context=CTX, timeout=60).read())
    except urllib.error.HTTPError as e:
        return {"_http_error": e.code, "_body": e.read().decode()[:300]}


def _proxy(sk, api_path, body=None):
    """Call the SPA's native /api handler the way ui_loader.js does (path in `p`)."""
    url = f"{BASE}/services/{APP}/proxy?p=" + urllib.parse.quote(api_path, safe="")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("Authorization", "Splunk " + sk)
    req.add_header("Content-Type", "application/json")
    try:
        return json.loads(urllib.request.urlopen(req, context=CTX, timeout=120).read())
    except urllib.error.HTTPError as e:
        return {"_http_error": e.code, "_body": e.read().decode()[:300]}


def check(name, cond, detail=""):
    global _passed
    if cond:
        _passed += 1
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        raise AssertionError(name)


def main():
    if not PW:
        print("SPLUNK_PASSWORD not set", file=sys.stderr)
        sys.exit(2)
    sk = _login()
    print("Authenticated to", BASE)
    _wait_kvstore(sk)

    # 1) ping
    d = _call(sk, "ping", {})
    check("ping ok", d.get("ok") is True, str(d))
    check("ping app id", d.get("app") == APP, str(d))

    # 2) create_addon -> derives TA_ id and resets project
    d = _call(sk, "create_addon", {"name": "ci_smoke", "version": "1.0.0"})
    check("create_addon ok", d.get("ok") is True, str(d))
    check("create_addon appId", d.get("appId") == "ta_ci_smoke", str(d))

    # 3) write_file globalConfig.json
    gc = json.dumps({"meta": {"name": "ta_ci_smoke", "displayName": "CI Smoke",
                              "version": "1.0.0", "schemaVersion": "0.0.3", "checkForUpdates": False}})
    d = _call(sk, "write_file", {"path": "globalConfig.json", "content": gc})
    check("write_file ok", d.get("ok") is True, str(d))
    check("write_file confined path", d.get("path") == "ta_ci_smoke/globalConfig.json", str(d))

    # 4) path-confinement: traversal must be rejected (security) — either an HTTP 400
    #    or a JSON {"error": ...}, and never ok.
    d = _call(sk, "write_file", {"path": "../../etc/passwd", "content": "x"})
    rejected = (d.get("_http_error") == 400) or bool(d.get("error"))
    check("traversal rejected", rejected and not d.get("ok"), str(d))

    # 5) list_project shows the file
    d = _call(sk, "list_project", {})
    check("list_project ok", d.get("ok") is True, str(d))
    check("list_project has globalConfig", "ta_ci_smoke/globalConfig.json" in (d.get("files") or []), str(d))

    # 6) read_file round-trips the content
    d = _call(sk, "read_file", {"path": "globalConfig.json"})
    check("read_file found", d.get("found") is True, str(d))
    check("read_file content round-trips", json.loads(d.get("content", "{}")).get("meta", {}).get("name") == "ta_ci_smoke", str(d)[:200])

    # 7) ai_config get -> providers + settings
    d = _call(sk, "ai_config", {"action": "get"})
    check("ai_config ok", d.get("ok") is True, str(d))
    check("ai_config providers", "openrouter" in (d.get("providers") or []), str(d))
    check("ai_config settings present", isinstance(d.get("settings"), dict), str(d))

    # 8) ai_config save -> persists a setting
    d = _call(sk, "ai_config", {"action": "save", "ai_provider": "openrouter", "ai_model": "anthropic/claude-sonnet-4.6"})
    check("ai_config save ok", d.get("ok") is True, str(d))
    check("ai_config saved model", (d.get("settings") or {}).get("ai_model") == "anthropic/claude-sonnet-4.6", str(d))

    # 9) My Apps (KV-backed multi-project library): save -> list -> load round-trips
    #    files -> delete -> gone. Pure KV, no Node engine / no LLM — fully deterministic.
    files = [{"path": "ta_ci_smoke/globalConfig.json", "content": gc},
             {"path": "ta_ci_smoke/README.md", "content": "# CI Smoke\n"}]
    d = _call(sk, "save_app", {"appId": "ta_ci_smoke", "name": "CI Smoke", "version": "1.0.0", "files": files})
    check("save_app ok", d.get("ok") is True, str(d))
    check("save_app fileCount", d.get("fileCount") == 2, str(d))

    d = _call(sk, "list_apps", {})
    check("list_apps ok", d.get("ok") is True, str(d))
    check("list_apps contains saved app",
          "ta_ci_smoke" in [a.get("appId") for a in (d.get("apps") or [])], str(d)[:300])

    d = _call(sk, "load_app", {"appId": "ta_ci_smoke"})
    check("load_app found", d.get("found") is True, str(d)[:200])
    loaded_paths = [f.get("path") for f in (d.get("files") or [])]
    check("load_app round-trips files", "ta_ci_smoke/README.md" in loaded_paths, str(loaded_paths)[:300])

    d = _call(sk, "delete_app", {"appId": "ta_ci_smoke"})
    check("delete_app ok", d.get("ok") is True, str(d))
    d = _call(sk, "load_app", {"appId": "ta_ci_smoke"})
    check("deleted app is gone", (d.get("_http_error") == 404) or (d.get("found") is False), str(d)[:200])

    # 10) Splunk Agent SDK chat surface (splunklib.ai), deterministic paths only — no LLM:
    #     - agent_start with NO key configured -> 400 "No API key" (proves the endpoint is
    #       wired + the config resolver runs, and that it refuses to spawn without a key).
    #     CI runs against a fresh container with no key. Against an instance that DOES have
    #     one (e.g. a dev box), agent_start would spawn a REAL, BILLABLE agent run — so
    #     cancel it immediately and assert the wiring rather than the refusal. Without this
    #     the smoke test silently burns LLM credit on every run.
    d = _call(sk, "agent_start", {"prompt": "hello"})
    if d.get("job_id"):
        _call(sk, "agent_cancel", {"job_id": d["job_id"]})
        check("agent_start spawns a job when a key IS configured", bool(d.get("model")), str(d)[:300])
        print("  NOTE  an API key is configured on this instance; started+cancelled a real job")
    else:
        check("agent_start without key -> 400", d.get("_http_error") == 400, str(d)[:300])
        check("agent_start error mentions API key", "API key" in (d.get("_body") or ""), str(d)[:300])

    #     - agent_poll on an unknown job -> 404, running False (never hangs the UI).
    d = _call(sk, "agent_poll", {"job_id": "deadbeef", "cursor": 0})
    check("agent_poll unknown job -> 404", d.get("_http_error") == 404, str(d)[:300])

    #     - agent_cancel on an unknown job -> 404 cancelled False (the new Stop endpoint is
    #       registered and degrades safely when there is nothing to kill).
    d = _call(sk, "agent_cancel", {"job_id": "deadbeef"})
    check("agent_cancel unknown job -> 404", d.get("_http_error") == 404, str(d)[:300])
    #     - agent_cancel with a malformed job id -> 400 (input validation).
    d = _call(sk, "agent_cancel", {"job_id": "../../etc"})
    check("agent_cancel rejects bad job id -> 400", d.get("_http_error") == 400, str(d)[:300])

    #     - agent_traces (durable run history) lists for this user (empty on a fresh KV is
    #       fine) and agent_trace on an unknown job -> 404 found:false.
    d = _call(sk, "agent_traces", {})
    check("agent_traces ok", d.get("ok") is True and isinstance(d.get("traces"), list), str(d)[:300])
    d = _call(sk, "agent_trace", {"job_id": "deadbeef"})
    check("agent_trace unknown job -> 404", d.get("_http_error") == 404, str(d)[:300])

    # 11) Dashboard generator handler is reachable inside splunkd and degrades cleanly when
    #     the Node engine sidecar isn't configured (the integration container has none): it
    #     must return a JSON error (400), NEVER a 500/crash — proving the handler imports and
    #     runs. (Full generation is covered hermetically by server/routes/generate.test.ts.)
    d = _call(sk, "generate_dashboard", {"title": "CI", "panels": [{"title": "p", "spl": "index=_internal", "viz": "table"}]})
    reachable = (d.get("ok") is True) or (d.get("_http_error") == 400)
    check("generate_dashboard reachable (no 500)", reachable, str(d)[:300])

    # 12) Seed from installed: the app lists itself (it has a globalConfig.json) and its source
    #     imports back — excluding vendored libs / bytecode — with path-traversal blocked.
    d = _call(sk, "list_installed_apps", {})
    check("list_installed_apps ok", d.get("ok") is True, str(d)[:200])
    check("list_installed_apps includes self",
          APP in [a.get("appId") for a in (d.get("apps") or [])], str(d)[:300])

    d = _call(sk, "import_installed_app", {"appId": APP})
    check("import_installed_app ok", d.get("ok") is True, str(d)[:200])
    paths = [f.get("path") for f in (d.get("files") or [])]
    # A BUILT add-on keeps globalConfig.json under appserver/static/js/build; the import
    # surfaces it at the PROJECT ROOT so the seed is a normal UCC source project.
    check("import surfaces globalConfig at root", f"{APP}/globalConfig.json" in paths, str(paths)[:300])
    check("import includes app.conf", f"{APP}/default/app.conf" in paths, str(paths)[:300])
    check("import includes bin source", any(p.startswith(f"{APP}/bin/") for p in paths), str(paths)[:300])
    check("import excludes vendored lib", not any("/lib/" in p for p in paths), str(paths)[:300])
    check("import excludes bytecode", not any(p.endswith(".pyc") for p in paths), str(paths)[:200])
    # No duplicate deep appserver copy of globalConfig.
    check("import has no appserver globalConfig dup",
          not any("appserver" in p and p.endswith("globalConfig.json") for p in paths), str(paths)[:300])

    d = _call(sk, "import_installed_app", {"appId": "../etc"})
    check("import rejects path traversal -> 400", d.get("_http_error") == 400, str(d)[:200])
    d = _call(sk, "import_installed_app", {"appId": "no_such_app_xyz"})
    check("import unknown app -> 404", d.get("_http_error") == 404, str(d)[:200])

    # 13) Model-choice endpoint backing the Configuration page's singleSelect dropdowns.
    #     No API key is configured in CI, so it must still answer with the fallback list in
    #     Splunk EAI shape ({entry: [{name, content:{label}}]}) - an empty or 500 response
    #     would render the dropdowns unusable.
    d = _get(sk, "ai_model_choices")
    entries = d.get("entry") if isinstance(d, dict) else None
    check("ai_model_choices returns EAI entries", isinstance(entries, list) and len(entries) > 0, str(d)[:300])
    check("ai_model_choices entries carry name + content.label",
          all(e.get("name") and isinstance(e.get("content"), dict) and e["content"].get("label")
              for e in entries), str(entries)[:300])

    # 14) The AUTHORITATIVE ucc-framework globalConfig schema is served in-Splunk, so the
    #     editor validates against what ucc-gen actually enforces (not the bundled subset).
    d = _proxy(sk, "/api/ucc/schema")
    check("ucc schema served", isinstance(d.get("schema"), dict) and d.get("uccVersion"), str(d)[:200])
    check("ucc schema is the full one (has definitions)",
          bool((d.get("schema") or {}).get("definitions")), str(list((d.get("schema") or {}).keys()))[:200])

    # 15) Schema pre-validation names the REAL offending property. `subTitle` on pages.inputs
    #     is the classic case: raw ucc-gen reports "'table' is a required property" from the
    #     other oneOf branch and sends an LLM into an add/remove-the-table loop.
    bad = {
        "meta": {"name": "ta_smoke", "restRoot": "ta_smoke", "version": "1.0.0",
                 "displayName": "Smoke", "schemaVersion": "0.0.3"},
        "pages": {"inputs": {
            "title": "Inputs", "subTitle": "nope", "description": "d",
            "table": {"header": [{"label": "Name", "field": "name"}], "actions": ["edit", "delete"]},
            "services": [{"name": "s", "title": "S", "entity": [
                {"type": "text", "label": "Name", "field": "name", "required": True}]}]}},
    }
    d = _proxy(sk, "/api/ucc/validate", {"globalConfig": bad})
    check("schema pre-validation rejects the bad config", d.get("ok") is False, str(d)[:300])
    check("schema pre-validation names subTitle",
          any("subTitle" in e for e in (d.get("errors") or [])), str(d.get("errors"))[:400])
    check("schema pre-validation lists what IS allowed",
          any("Allowed here" in e for e in (d.get("errors") or [])), str(d.get("errors"))[:400])

    good = json.loads(json.dumps(bad))
    del good["pages"]["inputs"]["subTitle"]
    d = _proxy(sk, "/api/ucc/validate", {"globalConfig": good})
    check("schema pre-validation accepts the fixed config", d.get("ok") is True, str(d)[:300])

    print(f"\nAll {_passed} checks passed.")


if __name__ == "__main__":
    try:
        main()
    except AssertionError:
        print("\nINTEGRATION TEST FAILED", file=sys.stderr)
        sys.exit(1)
