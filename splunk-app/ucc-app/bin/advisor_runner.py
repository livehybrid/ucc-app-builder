"""
UCC App Builder — Advisor agent runner (clean-subprocess entry point).

Why this exists: splunkd runs persistent REST handlers in a SHARED interpreter
that has dozens of OTHER apps' libraries cached in sys.modules / on sys.path.
Importing the vendored agent stack (splunklib.ai, pydantic v2, typing_extensions,
langchain, …) inside that process collides non-deterministically with whichever
versions another app loaded first. Rather than play whack-a-mole purging modules,
builder_advisor.py spawns THIS script as a fresh `/opt/splunk/bin/python3`
subprocess with PYTHONPATH = our lib only — a pristine interpreter, exactly like
the way the SDK already spawns bin/tools.py with zero collisions.

Protocol: read one JSON object from stdin:
  {session_key, prompt, model, base_url, api_key, max_steps}
Run the agent, print ONE JSON object to stdout:
  {"ok": true, "answer": "..."}  or  {"error": "...", "trace": "..."}
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
    "You are the UCC App Builder Advisor. Build a Splunk UCC add-on from the user's "
    "request using your tools. Workflow: call create_addon first; author globalConfig.json "
    "with write_file (it is the core artifact — inputs, configuration, UI; include "
    '"checkForUpdates": false in meta); then call build_and_inspect ONCE. '
    "Interpreting the result: `clean: true` means the package passed AppInspect with no "
    "FAILURES — this is success: STOP immediately and report it. If `clean` is false, the "
    "result lists actionable FAILURES; fix ONLY those by re-writing the source (never the "
    "generated default/*.conf), then call build_and_inspect again. Do this at most 2 more "
    "times. Never re-write to chase AppInspect WARNINGS — they are advisory and do not block "
    "packaging; if only warnings remain, STOP and report them. On an empty project, author "
    "globalConfig.json immediately — do not repeatedly list_project. Always end your turn "
    "with a short summary once clean (or once you have reported remaining failures)."
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


def _final_answer(result):
    """Extract the agent's final assistant message from an AgentResponse.

    `Agent.invoke()` returns an AgentResponse (messages=[Human/AI/Tool…], structured_output,
    …) — it has NO `.content`, so `str(result)` dumps the whole object. The user-facing
    answer is the LAST assistant message that carries text content (the markdown summary)."""
    msgs = getattr(result, "messages", None) or []
    for m in reversed(msgs):
        content = getattr(m, "content", None)
        role = getattr(m, "role", "")
        if isinstance(content, str) and content.strip() and (
                role == "assistant" or type(m).__name__ == "AIMessage"):
            return content
    # Fallbacks: a direct .content, else the structured output, else the repr.
    return (getattr(result, "content", None)
            or (str(getattr(result, "structured_output", "")) or None)
            or str(result))


async def _run_agent(service, prompt, model_name, base_url, api_key, max_steps,
                     provider="openrouter", temperature=None):
    from splunklib.ai.agent import Agent
    from splunklib.ai.messages import HumanMessage
    from splunklib.ai.limits import AgentLimits
    from splunklib.ai.tool_settings import ToolSettings, LocalToolSettings, ToolAllowlist

    model = _build_model(provider, model_name, base_url, api_key, temperature)
    async with Agent(
        service=service,
        model=model,
        system_prompt=SYSTEM_PROMPT,
        tool_settings=ToolSettings(
            local=LocalToolSettings(allowlist=ToolAllowlist(tags=["ucc_builder"])),
            remote=None,
        ),
        limits=AgentLimits(max_steps=max_steps),
    ) as agent:
        result = await agent.invoke([HumanMessage(content=prompt)])
    return _final_answer(result)


def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
        session_key = req.get("session_key") or ""
        prompt = str(req.get("prompt") or "").strip()
        model_name = str(req.get("model") or "anthropic/claude-sonnet-4.6")
        base_url = str(req.get("base_url") or "https://openrouter.ai/api/v1")
        api_key = req.get("api_key") or ""
        provider = str(req.get("provider") or "openrouter")
        temperature = req.get("temperature")
        try:
            max_steps = int(req.get("max_steps") or 40)
        except (TypeError, ValueError):
            max_steps = 40
        if not prompt:
            print(json.dumps({"error": "prompt is required"}))
            return
        if not api_key:
            print(json.dumps({"error": "missing api_key"}))
            return

        _ensure_ca_bundle()
        import splunklib.client as client
        token = session_key if session_key.startswith("Splunk ") else ("Splunk " + session_key)
        service = client.Service(scheme="https", host="127.0.0.1", port=8089,
                                 token=token, app=APP, owner="nobody")
        answer = asyncio.run(_run_agent(service, prompt, model_name, base_url, api_key, max_steps,
                                        provider=provider, temperature=temperature))
        print(json.dumps({"ok": True, "model": model_name, "answer": answer}))
    except BaseException as e:  # noqa: BLE001 — surface the real cause (incl. ExceptionGroup)
        import traceback
        subs = getattr(e, "exceptions", None)
        if subs:
            msg = "; ".join(f"{type(s).__name__}: {s}" for s in subs)
        else:
            msg = f"{type(e).__name__}: {e}"
        print(json.dumps({"error": msg, "trace": traceback.format_exc()[-1800:]}))


if __name__ == "__main__":
    main()
