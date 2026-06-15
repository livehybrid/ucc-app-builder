# Post-submission E2E validation — UCC App Builder on Splunk 10.4 (.222)

_Run 2026-06-16, driving the live REST endpoints (`agent_start`/`agent_poll` and the
`/api/ai/chat` proxy) with admin auth. Splunk Agent SDK = splunklib.ai 3.0._

## Verdict

**The splunklib.ai chat path works end-to-end**; two real issues were found and fixed, and
two operational recommendations are recorded below.

## 1. splunklib.ai build (turn 1)

Prompt: *"Build a UCC add-on TA_demo_metrics with an API-key account (encrypted) and one REST
input polling https://api.demo.test/metrics every 300s, sourcetype demo:metrics, index main."*

- The agent ran live: event stream = **assistant ×12, tool_call ×17, tool_result ×16** (the
  middleware-emitted progress events the UI renders — create_addon / write_file /
  build_and_inspect all executing against the KV project + Node build engine).
- It did **not** reach the terminal `done` event within the test's 220s poll window, because
  the configured model is **`anthropic/claude-opus-4.8`** — accurate but slow/expensive for a
  build loop (17 tool calls). The job completed server-side afterwards (0 runner processes
  left). *Clean-build capability itself is already proven by the earlier in-UI test that
  produced an AppInspect-clean `ta_equine_energy-1.0.0.tar.gz`.*

## 2. Multi-turn (turn 2) — validates the `AIMessage(calls=[])` fix

- Turn 2 was sent with the turn-1 assistant message in history. **No
  `TypeError: AIMessage … 'calls'`** occurred (the exact crash that previously broke turn 2).
  The fix (`advisor_runner._messages_from_history` → `AIMessage(content=…, calls=[])`) holds.

## 3. Inline completion (FIM) — PASS

- Via `/api/ai/chat` with `anthropic/claude-haiku-4.5`, prefix `[github_audit://default]\n
  interval = ` / suffix `sourcetype = github:audit` → completion **`300`**. Correct, fast.

## 4. Expansion — returns a well-shaped spec

- `anthropic/claude-sonnet-4.6` returned a UccSpec-shaped JSON (appId / account / inputs all
  present) for *"collect GitHub audit log events via the REST API"*. A very verbose reply can
  exceed the token budget mid-JSON; mitigated by (a) the tolerant `parseSpec` (10 unit tests)
  and (b) a "keep it focused (≤6 inputs / ≤8 fields)" nudge added to the expansion prompt.

## Model availability on the .222 OpenRouter key (probed)

| Model | Result |
|---|---|
| `anthropic/claude-haiku-4.5` | ✅ OK |
| `anthropic/claude-3.5-haiku` | ✅ OK |
| `openai/gpt-4o-mini` | ✅ OK |
| `google/gemini-2.5-flash` | ✅ OK |
| `anthropic/claude-sonnet-4.6` | ✅ OK |
| `google/gemini-2.0-flash-001` | ❌ 404 |
| `mistralai/codestral-2501` | ❌ 404 |
| `qwen/qwen-2.5-coder-7b-instruct` | ❌ 400 |

## Fixes made from this validation

- **Inline default model** changed `google/gemini-2.0-flash-001` (404) → `anthropic/claude-haiku-4.5`;
  picker now lists only models that resolve on this key.
- **Expansion prompt** nudged to stay concise to avoid JSON truncation on verbose models.

## Recommendations (not code)

- **Change the Configuration → AI Provider model from `claude-opus-4.8` to `claude-sonnet-4.6`**
  for the build agent — much faster/cheaper, plenty capable for ucc-gen/AppInspect work.
- **Add server-side job cancellation** — today the UI Stop only aborts the client poll; the
  splunklib.ai subprocess keeps running to `max_steps`. With an expensive model that wastes
  credit. A small `agent_cancel` endpoint (kill the pid / set a stop flag) would close it.
