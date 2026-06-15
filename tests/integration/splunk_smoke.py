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

    print(f"\nAll {_passed} checks passed.")


if __name__ == "__main__":
    try:
        main()
    except AssertionError:
        print("\nINTEGRATION TEST FAILED", file=sys.stderr)
        sys.exit(1)
