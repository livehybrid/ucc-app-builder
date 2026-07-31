"""
UCC App Builder - Advisor agent runner (clean-subprocess entry point).

Why this exists: splunkd runs persistent REST handlers in a SHARED interpreter
that has dozens of OTHER apps' libraries cached in sys.modules / on sys.path.
Importing the vendored agent stack (splunklib.ai, pydantic v2, typing_extensions,
langchain, …) inside that process collides non-deterministically with whichever
versions another app loaded first. Rather than play whack-a-mole purging modules,
builder_advisor.py / builder_agent.py spawn THIS script as a fresh
`/opt/splunk/bin/python3` subprocess with PYTHONPATH = our lib only - a pristine
interpreter, exactly like the way the SDK already spawns bin/tools.py with zero
collisions.

Protocol - read one JSON object from stdin:
  { session_key, prompt | messages, model, base_url, api_key, provider,
    temperature, max_steps, events_path? }
  - `messages`: optional [{role, content}] conversation history (the SPA chat owns
    its history). When present the last user turn is the new prompt; `prompt` is a
    single-turn fallback.
  - `events_path`: optional file. When set, the runner appends ONE JSON object per
    line as the agent works - `{event: "assistant"|"tool_call"|"tool_result"}` -
    via an SDK AgentMiddleware, so a polling REST handler can surface live progress
    through Splunk's buffering proxy (which cannot stream SSE). A terminal
    `{event:"done", answer, files}` (or `{event:"error"}`) is always written last.

Always prints ONE terminal JSON object to stdout (back-compat with the blocking
Advisor handler): {"ok": true, "answer": "...", "files":[...]} or {"error": "..."}.
"""
import asyncio
import json
import os
import sys

_bin = os.path.dirname(os.path.abspath(__file__))
_lib = os.path.join(os.path.dirname(_bin), "lib")
for _p in (_lib, _bin):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Standalone subprocess: restore the Splunk env that splunk.rest (used by the
# tools' KV access, and the SDK's privilege check) requires.
if "SPLUNK_HOME" not in os.environ:
    os.environ["SPLUNK_HOME"] = os.path.normpath(os.path.join(_bin, "..", "..", "..", ".."))
if "SPLUNK_DB" not in os.environ:
    os.environ["SPLUNK_DB"] = os.path.join(os.environ["SPLUNK_HOME"], "var", "lib", "splunk")

APP = "ucc_app_builder"

SYSTEM_PROMPT = (
    "You are the UCC App Builder Advisor. Build or EXTEND a Splunk UCC add-on from the "
    "user's request using your tools.\n"
    "CLARIFY BEFORE YOU BUILD - NEVER INVENT AN INTEGRATION CONTRACT. You have NO network "
    "access: you cannot open a URL, read API documentation, or probe an endpoint, and none "
    "of your tools can. So when the request names an external API or service whose contract "
    "you do not already KNOW, do not guess it. Ask the user, in ONE short message, then STOP "
    "and wait for their reply. Ask only about what you genuinely cannot proceed without, and "
    "suggest a sensible default for each so they can just say 'defaults are fine':\n"
    "  - authentication: none / API key / bearer token / basic / OAuth, and the exact header "
    "or query-parameter name (MOST APIs need auth - assuming an anonymous GET is the single "
    "most common way to waste a whole build cycle);\n"
    "  - the endpoint path(s), required query parameters, and the base URL;\n"
    "  - the response shape - ideally a sample payload - and which field holds the records;\n"
    "  - paging, rate limits, and how often to poll.\n"
    "Skip the questions and build straight away when the user has already supplied the "
    "contract, pasted a sample response, or told you to assume something. Once they answer, "
    "build without another round of questions.\n"
    "When you DO build an authenticated input, model the credential as an `encrypted` UCC "
    "field (or an account/oauth entity) - never a plain-text text field, and never hardcode "
    "a key in python.\n"
    "FIRST, call list_project. If it returns files, a project is ALREADY LOADED - do NOT "
    "call create_addon (it RESETS the project and destroys the user's work); read what you "
    "need with read_file and EXTEND that project in place. Only call create_addon when the "
    "project is EMPTY (no files) and the user wants a brand-new add-on.\n"
    "Author globalConfig.json with write_file (the core artifact - inputs, configuration, "
    'UI; include "checkForUpdates": false in meta).\n'
    "VALIDATE THE SCHEMA BEFORE YOU BUILD. After writing globalConfig.json, call "
    "validate_global_config - it checks the real ucc-framework schema in seconds, with no "
    "build. Only call build_and_inspect once it passes. Fix EXACTLY the paths it lists and "
    "nothing else.\n"
    "UCC SCHEMA RULES (ucc-gen 6.5+ rejects violations): every inputs service AND every "
    "configuration tab that lists rows MUST have a `table` (with `header` and `actions`). "
    "Valid table `actions` are ONLY: edit, delete, clone, search - NEVER 'enable'/'disable' "
    "(enable/disable is driven automatically by the `disabled` status column, not an action). "
    "`pages.inputs` accepts `subDescription`, NOT `subTitle` (`subTitle` is a SERVICE-level "
    "key) - a stray key there is the classic cause of the confusing errors below. "
    "If the add-on has a UI, its package/lib/requirements.txt MUST include splunktaucclib>=8.2.0 "
    "and solnlib.\n"
    "READING SCHEMA ERRORS - DO NOT THRASH. `pages.inputs` is a `oneOf` (one page-level table, "
    "OR a table per service). When it fails, raw ucc-gen reports only ONE branch's complaint, "
    "which is usually NOT the real mistake: an unknown property makes BOTH branches fail, and "
    "you get \"'table' is a required property\" or \"... should not be valid under {'required': "
    "['table']}\" while the actual culprit (a misspelled key) is never named. So: NEVER conclude "
    "'the schema says table is required' from that message and start adding/removing tables. "
    "Instead call validate_global_config (it names the offending property and lists what IS "
    "allowed at that path) and, if still unclear, ucc_schema_help('InputsPage') for the full "
    "shape. If the same error survives two DISTINCT fixes, stop guessing - call ucc_schema_help, "
    "or report the blocker to the user. Never re-apply a fix you have already tried.\n"
    "For knowledge objects, prefer the dedicated generators over hand-writing: call "
    "generate_dashboard to add a DASHBOARD (it emits a Dashboard Studio v2 view - do NOT "
    "hand-author Simple XML); generate_savedsearch for a report or alert; generate_tests "
    "for a pytest-splunk-addon validation suite. Ground SPL in real indexes/sourcetypes.\n"
    "MAKE THE DATA USEFUL, and be even-handed about how. An add-on that only ingests is "
    "half a deliverable, so before you finish consider ALL THREE companions - a Dashboard "
    "Studio overview (generate_dashboard: trend, breakdown, KPI - the 'is my data flowing?' "
    "view), a scheduled report or alert (generate_savedsearch), and a test suite "
    "(generate_tests). Add the ones the user's request clearly implies; for the rest, OFFER "
    "them explicitly as a short numbered list in your closing summary so the user can accept "
    "with one word. Do not silently add one companion while never mentioning the others.\n"
    "To validate the build, call build_and_inspect (ONCE per attempt). `clean: true` means "
    "AppInspect passed with no FAILURES - success: STOP and report it. If `clean` is false, "
    "fix ONLY the listed FAILURES by re-writing the source (never the generated "
    "default/*.conf), then call build_and_inspect again, at most 2 more times. Never chase "
    "AppInspect WARNINGS - they are advisory and do not block packaging. Always end your "
    "turn with a short summary once clean (or once you have reported remaining failures).\n"
    "STYLE: in all generated files AND your chat replies, use regular hyphens (-), never "
    "em-dashes or en-dashes."
)


def _ensure_ca_bundle():
    # Point outbound TLS (httpx in langchain-openai) at the vendored certifi bundle.
    cur = os.environ.get("SSL_CERT_FILE")
    if cur and os.path.isfile(cur):
        return
    try:
        import certifi
        bundle = certifi.where()
        if os.path.isfile(bundle):
            os.environ["SSL_CERT_FILE"] = bundle
            os.environ["REQUESTS_CA_BUNDLE"] = bundle
            os.environ.pop("SSL_CERT_DIR", None)
    except Exception:
        pass


def _build_model(provider, model_name, base_url, api_key, temperature):
    """Provider-agnostic model selection (mirrors TrackMe's ai_provider menu)."""
    from splunklib.ai.model import OpenAIModel
    temp = None
    try:
        if temperature is not None and str(temperature) != "":
            temp = float(temperature)
    except (TypeError, ValueError):
        temp = None
    provider = (provider or "openrouter").lower()
    if provider == "anthropic":
        from splunklib.ai.model import AnthropicModel
        return AnthropicModel(model=model_name, api_key=api_key,
                              base_url=base_url or "https://api.anthropic.com", temperature=temp)
    if provider == "google":
        from splunklib.ai.model import GoogleModel
        return GoogleModel(model=model_name, api_key=api_key, temperature=temp)
    # openrouter / openai (and any OpenAI-compatible gateway) -> OpenAIModel + base_url.
    return OpenAIModel(model=model_name, base_url=base_url or "https://openrouter.ai/api/v1",
                       api_key=api_key, temperature=temp)


def _text_from_content(content):
    """Flatten an AIMessage.content (str | list[str | TextBlock | …]) to plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, (list, tuple)):
        parts = []
        for blk in content:
            if isinstance(blk, str):
                parts.append(blk)
            else:
                txt = getattr(blk, "text", None)
                if isinstance(txt, str):
                    parts.append(txt)
        return "".join(parts)
    return ""


def _messages_from_history(history, prompt):
    """Rebuild the SDK message list from the SPA's [{role, content}] history. The chat
    owns its history; we map user→HumanMessage and assistant→AIMessage (tool/system are
    skipped - the system prompt is fixed and tool turns are summarised by the assistant
    text the model already saw). Falls back to a single HumanMessage(prompt)."""
    from splunklib.ai.messages import HumanMessage, AIMessage
    msgs = []
    for m in (history or []):
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "").lower()
        content = m.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        if role == "user":
            msgs.append(HumanMessage(content=content))
        elif role == "assistant":
            # AIMessage requires `calls` (kw-only, no default). A turn reconstructed from
            # the chat's stored TEXT carries no live tool calls to replay, so calls=[] -
            # the model just sees what it previously said, for context.
            msgs.append(AIMessage(content=content, calls=[]))
    if not msgs and prompt:
        msgs.append(HumanMessage(content=prompt))
    return msgs


def _final_answer(result):
    """Extract the agent's final assistant message from an AgentResponse.

    `Agent.invoke()` returns an AgentResponse (messages=[Human/AI/Tool…], structured_output,
    …) - it has NO `.content`, so `str(result)` dumps the whole object. The user-facing
    answer is the LAST assistant message that carries text content (the markdown summary)."""
    msgs = getattr(result, "messages", None) or []
    for m in reversed(msgs):
        content = getattr(m, "content", None)
        role = getattr(m, "role", "")
        if (role == "assistant" or type(m).__name__ == "AIMessage"):
            text = _text_from_content(content)
            if text and text.strip():
                return text
    # Fallbacks: a direct .content, else the structured output, else the repr.
    return (getattr(result, "content", None)
            or (str(getattr(result, "structured_output", "")) or None)
            or str(result))


def _username(service):
    """Resolve the authenticated username (so we read back the SAME KV project the
    tools wrote to - builder_agent_tools keys the store by username)."""
    try:
        resp = service.get("/services/authentication/current-context", output_mode="json")
        body = resp.body.read() if hasattr(resp.body, "read") else resp.body
        entry = json.loads(body).get("entry", [])
        if entry:
            return entry[0].get("content", {}).get("username") or "advisor"
    except Exception:
        pass
    return "advisor"


def _project_files(session_key, service):
    """Dump the agent's project files (path/content) from the KV store for VFS sync."""
    try:
        import builder_common
        store = builder_common.KVProjectStore(session_key, app=APP, user=_username(service))
        return store.dump()
    except Exception:
        return []


def _persist_trace(session_key, user, job_id, meta, events):
    """Durably record this run's full progress trace to the ucc_agent_traces KV collection
    (best-effort - never let a tracing failure mask the run's real result)."""
    if not session_key or not job_id:
        return
    try:
        import builder_common
        meta = dict(meta)
        meta["step_count"] = sum(1 for e in events
                                 if isinstance(e, dict) and e.get("event") == "tool_call")
        builder_common.KVAgentTraces(session_key, APP, user=user).save(job_id, meta, events)
    except Exception:
        pass


def _make_event_sink(events_path):
    """Return an `emit(dict)` that appends one JSON line to events_path and flushes
    (so a polling reader sees each event as it happens). No-op when path is unset."""
    if not events_path:
        return lambda _e: None

    def emit(event):
        try:
            with open(events_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(event, default=str) + "\n")
                fh.flush()
        except Exception:
            pass

    return emit


def _stream_middleware(emit):
    """An AgentMiddleware that emits live progress events as the agent works:
    `assistant` (per model reply with text), `tool_call` (before each tool), and
    `tool_result` (after each tool, with success/failure)."""
    from splunklib.ai.middleware import AgentMiddleware

    class _Stream(AgentMiddleware):
        async def model_middleware(self, request, handler):
            resp = await handler(request)
            try:
                text = _text_from_content(getattr(resp.message, "content", ""))
                if text and text.strip():
                    emit({"event": "assistant", "content": text})
            except Exception:
                pass
            return resp

        async def tool_middleware(self, request, handler):
            call = request.call
            emit({"event": "tool_call", "id": getattr(call, "id", ""),
                  "name": getattr(call, "name", ""), "args": getattr(call, "args", {})})
            resp = await handler(request)
            try:
                result = resp.result
                content = getattr(result, "content", None)
                errored = content is None
                if errored:
                    content = getattr(result, "error_message", None) or str(result)
                emit({"event": "tool_result", "id": getattr(call, "id", ""),
                      "name": getattr(call, "name", ""), "content": str(content),
                      "errored": errored})
            except Exception:
                pass
            return resp

    return _Stream()


async def _run_agent(service, messages, model_name, base_url, api_key, max_steps,
                     provider="openrouter", temperature=None, emit=None):
    from splunklib.ai.agent import Agent
    from splunklib.ai.limits import AgentLimits
    from splunklib.ai.tool_settings import ToolSettings, LocalToolSettings, ToolAllowlist

    model = _build_model(provider, model_name, base_url, api_key, temperature)
    middleware = [_stream_middleware(emit)] if emit else None
    async with Agent(
        service=service,
        model=model,
        system_prompt=SYSTEM_PROMPT,
        tool_settings=ToolSettings(
            local=LocalToolSettings(allowlist=ToolAllowlist(tags=["ucc_builder"])),
            remote=None,
        ),
        limits=AgentLimits(max_steps=max_steps),
        middleware=middleware,
    ) as agent:
        result = await agent.invoke(messages)
    return _final_answer(result)


def main():
    events_path = None
    emit = lambda _e: None  # noqa: E731 - replaced once we parse the request
    try:
        # Request comes either as a file path argument (background job: builder_agent.py
        # writes it so a large message history can't deadlock a stdin pipe, and the
        # secret isn't on the process args) or on stdin (blocking Advisor: builder_advisor.py).
        # A request file holds the API key, so unlink it as soon as it's read.
        raw = ""
        if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
            with open(sys.argv[1], "r", encoding="utf-8") as fh:
                raw = fh.read()
            try:
                os.unlink(sys.argv[1])
            except OSError:
                pass
        else:
            raw = sys.stdin.read()
        req = json.loads(raw or "{}")
        session_key = req.get("session_key") or ""
        prompt = str(req.get("prompt") or "").strip()
        history = req.get("messages")
        model_name = str(req.get("model") or "anthropic/claude-sonnet-4.6")
        base_url = str(req.get("base_url") or "https://openrouter.ai/api/v1")
        api_key = req.get("api_key") or ""
        provider = str(req.get("provider") or "openrouter")
        temperature = req.get("temperature")
        events_path = req.get("events_path")
        # Durable trace: accumulate every emitted event so we can persist the whole run to
        # KV at terminal (the per-job .jsonl is TTL-pruned). job_id keys the trace row;
        # derive it from the events file name when not passed explicitly.
        trace_events = []
        job_id = req.get("job_id") or (
            os.path.basename(events_path).rsplit(".", 1)[0] if events_path else None)
        _sink = _make_event_sink(events_path)

        def emit(event):
            trace_events.append(event)
            _sink(event)
        try:
            max_steps = int(req.get("max_steps") or 40)
        except (TypeError, ValueError):
            max_steps = 40

        messages = _messages_from_history(history, prompt)
        if not messages:
            err = {"error": "prompt or messages is required"}
            emit({"event": "error", **err})
            print(json.dumps(err))
            return
        if not api_key:
            err = {"error": "missing api_key"}
            emit({"event": "error", **err})
            print(json.dumps(err))
            return

        _ensure_ca_bundle()
        import splunklib.client as client
        token = session_key if session_key.startswith("Splunk ") else ("Splunk " + session_key)
        service = client.Service(scheme="https", host="127.0.0.1", port=8089,
                                 token=token, app=APP, owner="nobody")
        answer = asyncio.run(_run_agent(service, messages, model_name, base_url, api_key,
                                        max_steps, provider=provider, temperature=temperature,
                                        emit=emit))
        files = _project_files(session_key, service)
        emit({"event": "done", "ok": True, "model": model_name, "answer": answer, "files": files})
        print(json.dumps({"ok": True, "model": model_name, "answer": answer, "files": files}))
        trace_prompt = prompt or next(
            (str(getattr(m, "content", "") or "") for m in reversed(messages)
             if getattr(m, "type", None) == "human"), "")
        _persist_trace(session_key, _username(service), job_id,
                       {"status": "done", "model": model_name, "provider": provider,
                        "prompt": trace_prompt, "answer": answer}, trace_events)
    except BaseException as e:  # noqa: BLE001 - surface the real cause (incl. ExceptionGroup)
        import traceback

        def _flatten_exc(exc):
            # asyncio TaskGroup failures raise (possibly NESTED) ExceptionGroups; recurse to
            # the leaf exceptions so the user sees the real cause, not "1 sub-exception".
            subs = getattr(exc, "exceptions", None)
            if subs:
                out = []
                for s in subs:
                    out.extend(_flatten_exc(s))
                return out
            return [exc]

        leaves = _flatten_exc(e)
        msg = "; ".join(f"{type(s).__name__}: {s}" for s in leaves) if leaves else f"{type(e).__name__}: {e}"
        trace = traceback.format_exc()[-1800:]
        # Surface whatever the agent managed to write before failing (e.g. it exhausted its
        # step budget mid-task) so the UI can sync the partial project back into the VFS -
        # otherwise a subsequent "Continue" would re-sync the stale VFS over the agent's work.
        partial_files = None
        try:
            if "service" in locals() and locals().get("session_key"):
                partial_files = _project_files(session_key, service)
        except Exception:
            partial_files = None
        try:
            err_ev = {"event": "error", "error": msg, "trace": trace}
            if partial_files:
                err_ev["files"] = partial_files
            emit(err_ev)
        except Exception:
            pass
        print(json.dumps({"error": msg, "trace": trace}))
        # Durably record the failed run too (best-effort; locals may be unset if we failed
        # very early, so resolve them defensively).
        try:
            _persist_trace(
                locals().get("session_key") or "",
                _username(service) if "service" in locals() else None,
                locals().get("job_id"),
                {"status": "error", "model": locals().get("model_name") or "",
                 "provider": locals().get("provider") or "",
                 "prompt": locals().get("prompt") or "", "error": msg},
                locals().get("trace_events") or [])
        except Exception:
            pass


if __name__ == "__main__":
    main()
