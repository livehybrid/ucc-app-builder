"""
UCC App Builder — Splunk Agent SDK (splunklib.ai) chat backend, job + poll style.

The in-app SPA chat is driven by the **Splunk Agent SDK** (`splunklib.ai`) — the same
agent the Advisor uses, with the builder tools (tagged `ucc_builder`) — but as a
multi-turn, live-progress chat. Splunk persistent REST handlers must return their whole
payload at once (they can't stream SSE), and the embedded SPA reaches the engine through
a *buffering* proxy, so we surface progress by **polling**:

  POST /ucc_app_builder/agent_start  { messages|prompt, model?, ... }  -> { job_id }
      spawns advisor_runner.py as a detached subprocess that appends JSONL progress
      events (assistant / tool_call / tool_result / done) to a per-job file.

  POST /ucc_app_builder/agent_poll   { job_id, cursor }  -> { events, cursor, running }
      returns the events written since `cursor`; each poll is a separate (buffered)
      round-trip, so the chat fills in step by step.

AI provider/key/model resolution is shared with the Advisor (builder_advisor.py): the
unified UCC Configuration-page [ai_provider] settings, falling back to the legacy
[advisor] stanza + storage/passwords realm.
"""
import json
import os
import subprocess
import sys
import time
import uuid

from splunk.persistconn.application import PersistentServerConnectionApplication

_BIN = os.path.dirname(os.path.abspath(__file__))
_LIB = os.path.join(os.path.dirname(_BIN), "lib")
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)
if _BIN not in sys.path:
    sys.path.insert(0, _BIN)
_RUNNER = os.path.join(_BIN, "advisor_runner.py")
_SPLUNK_HOME = os.path.normpath(os.path.join(_BIN, "..", "..", "..", ".."))
_JOB_DIR = os.path.join(_SPLUNK_HOME, "var", "run", "ucc_app_builder", "agent")

# Reuse the Advisor's AI-config resolution (unified [ai_provider] + legacy fallback).
import builder_advisor as ba  # noqa: E402

APP = "ucc_app_builder"
DEFAULT_BASE_URL = ba.DEFAULT_BASE_URL
DEFAULT_MODEL = ba.DEFAULT_MODEL
_JOB_TTL_SECONDS = 3600


def _json_response(payload, status=200):
    return {"status": status, "payload": json.dumps(payload),
            "headers": {"Content-Type": "application/json"}}


def _action_from_path(req):
    path = ""
    for key in ("path_info", "rest_path", "path"):
        v = req.get(key)
        if isinstance(v, str) and v:
            path = v
            break
    return path.rstrip("/").rsplit("/", 1)[-1] or ""


def _args(req):
    payload = req.get("payload")
    if isinstance(payload, str) and payload.strip():
        try:
            return json.loads(payload)
        except ValueError:
            return {}
    return {}


def _safe_job_id(raw):
    """job_id is generated as a uuid hex; accept only that shape so it can never
    escape the job dir as a path."""
    s = str(raw or "")
    return s if (s and len(s) <= 64 and all(c in "0123456789abcdef" for c in s)) else None


def _prune_old_jobs():
    try:
        now = time.time()
        for fn in os.listdir(_JOB_DIR):
            fp = os.path.join(_JOB_DIR, fn)
            try:
                if now - os.path.getmtime(fp) > _JOB_TTL_SECONDS:
                    os.unlink(fp)
            except OSError:
                pass
    except OSError:
        pass


def _pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


class AgentHandler(PersistentServerConnectionApplication):
    def __init__(self, command_line=None, command_arg=None):
        super(AgentHandler, self).__init__()

    def handle(self, in_string):
        try:
            req = json.loads(in_string) if in_string else {}
            session_key = ba._get_session_key(req)
            if not session_key:
                return _json_response({"error": "Missing session key"}, status=401)
            action = _action_from_path(req)
            if action == "agent_start":
                return self._start(req, session_key)
            if action == "agent_poll":
                return self._poll(req, session_key)
            return _json_response({"error": f"Unknown action: {action}"}, status=404)
        except BaseException as e:  # noqa: BLE001
            import traceback
            return _json_response({"error": f"{type(e).__name__}: {e}",
                                   "trace": traceback.format_exc()[-1800:]}, status=500)

    def _start(self, req, session_key):
        args = _args(req)
        prompt = str(args.get("prompt") or "").strip()
        messages = args.get("messages")
        if not prompt and not (isinstance(messages, list) and messages):
            return _json_response({"error": "prompt or messages is required"}, status=400)

        # Unified AI-provider config (UCC Configuration page → legacy fallback).
        ucc = ba.ucc_ai_settings(session_key)
        provider = str(args.get("provider") or ucc.get("provider")
                       or ba._get_conf(session_key, "ai_provider", "openrouter")).lower()
        base_url = (ucc.get("base_url")
                    or ba._get_conf(session_key, "ai_base_url", DEFAULT_BASE_URL))
        model_name = str(args.get("model") or ucc.get("model")
                         or ba._get_conf(session_key, "ai_model", DEFAULT_MODEL))
        temperature = args.get("temperature")
        if temperature is None or temperature == "":
            temperature = ucc.get("temperature") or ba._get_conf(session_key, "temperature", "")
        api_key = ucc.get("api_key") or ba._api_key_for(session_key, provider)
        if not api_key:
            return _json_response({"error": f"No API key for provider '{provider}'. Set one in "
                                            "the app's Configuration → AI Provider tab."}, status=400)
        try:
            max_steps = int(args.get("max_steps") or ucc.get("max_iterations")
                            or ba._get_conf(session_key, "max_steps", "40"))
        except (TypeError, ValueError):
            max_steps = 40

        os.makedirs(_JOB_DIR, exist_ok=True)
        _prune_old_jobs()
        job_id = uuid.uuid4().hex
        events_path = os.path.join(_JOB_DIR, job_id + ".jsonl")
        req_path = os.path.join(_JOB_DIR, job_id + ".req.json")
        # Create the events file up front so an immediate poll finds an (empty) job.
        open(events_path, "a", encoding="utf-8").close()

        payload = {
            "session_key": session_key, "prompt": prompt, "messages": messages,
            "model": model_name, "base_url": base_url, "api_key": api_key,
            "max_steps": max_steps, "provider": provider, "temperature": temperature,
            "events_path": events_path,
        }
        # Write the request (incl. the key) to a 0600 file the runner reads then unlinks
        # — avoids a stdin-pipe deadlock on a large history and keeps the key off argv.
        fd = os.open(req_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(payload))

        env = {
            "SPLUNK_HOME": _SPLUNK_HOME,
            "SPLUNK_DB": os.path.join(_SPLUNK_HOME, "var", "lib", "splunk"),
            "LD_LIBRARY_PATH": os.path.join(_SPLUNK_HOME, "lib"),
            "PYTHONPATH": _LIB + os.pathsep + _BIN,
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        }
        python = os.path.join(_SPLUNK_HOME, "bin", "python3")
        stderr_path = os.path.join(_JOB_DIR, job_id + ".stderr")
        with open(stderr_path, "w", encoding="utf-8") as errfh:
            proc = subprocess.Popen(
                [python, _RUNNER, req_path],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errfh,
                env=env, cwd=_BIN, start_new_session=True,
            )
        try:
            with open(os.path.join(_JOB_DIR, job_id + ".pid"), "w", encoding="utf-8") as pf:
                pf.write(str(proc.pid))
        except OSError:
            pass
        return _json_response({"job_id": job_id, "model": model_name})

    def _poll(self, req, session_key):
        args = _args(req)
        job_id = _safe_job_id(args.get("job_id"))
        if not job_id:
            return _json_response({"error": "valid job_id is required"}, status=400)
        try:
            cursor = int(args.get("cursor") or 0)
        except (TypeError, ValueError):
            cursor = 0
        events_path = os.path.join(_JOB_DIR, job_id + ".jsonl")
        if not os.path.isfile(events_path):
            return _json_response({"events": [], "cursor": 0, "running": False,
                                   "error": "unknown or expired job"}, status=404)

        try:
            with open(events_path, "r", encoding="utf-8") as fh:
                lines = fh.read().splitlines()
        except OSError:
            lines = []
        # cursor counts RAW lines consumed (the file only grows), so the new cursor is
        # simply the current line count regardless of which lines parse.
        new_cursor = len(lines)
        parsed_all = []
        for ln in lines:
            ln = ln.strip()
            if ln.startswith("{"):
                try:
                    parsed_all.append(json.loads(ln))
                except ValueError:
                    pass
        new = []
        for ln in lines[cursor:]:
            ln = ln.strip()
            if ln.startswith("{"):
                try:
                    new.append(json.loads(ln))
                except ValueError:
                    pass

        terminal = bool(parsed_all) and parsed_all[-1].get("event") in ("done", "error")
        running = not terminal
        if running:
            # No terminal event yet — confirm the worker is still alive; if it died
            # without writing one (OOM/kill), surface a synthetic error so the UI stops.
            pid = None
            try:
                with open(os.path.join(_JOB_DIR, job_id + ".pid"), "r", encoding="utf-8") as pf:
                    pid = pf.read().strip()
            except OSError:
                pid = None
            if pid is not None and not _pid_alive(pid):
                new.append({"event": "error", "error": "agent process exited unexpectedly"})
                running = False

        return _json_response({"events": new, "cursor": new_cursor, "running": running})
