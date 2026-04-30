# Agent Rebuild — Research Synthesis & Implementation Plan

> **Goal:** Evolve `apps/ucc-app-builder` into a market-leading "Lovable-for-Splunk" experience where a Splunk admin who cannot write Python can ship production-quality UCC add-ons by chatting.
>
> **Deployment target:** Hosted SaaS (primary) + self-host option.
> **Budget:** Quality tier (Claude Opus / Sonnet 4.5 / GPT-5 class).
> **Output:** This document is the report. A concrete phased roadmap and list of changes follows at the bottom.

---

## 1. Executive summary

Today's `AIChatPanel` is a **single-model, single-loop, tool-calling chat** that writes files in a virtual filesystem and proxies OpenRouter. It is the right skeleton but lags SOTA coding agents on four axes:

1. **Loop shape** — it has no planner / executor split and no explicit `todo` state. Single-pass tool calling frequently stalls on multi-file UCC apps.
2. **Tool set** — `write_file` (full rewrite) is the only edit primitive, no `apply_patch`, no subagent delegation, no explicit planning tool.
3. **Knowledge** — there is a `consultDocumentation` tool, but no real RAG index of UCC schemas, `.conf` specs, splunklib, AppInspect rules, or canonical examples.
4. **Eval + safety** — no regression harness, no per-session observability, and path-only isolation (no sandbox).

The research across six questions (archived in `01-…` through `06-…`) converges on a **clear target architecture**: a two-model planner/executor loop with a domain-specific tool library backed by a hybrid RAG layer, gated by an approval UI that defaults to plain English and hides code behind toggles, sandboxed per-session with Firecracker / gVisor in SaaS mode, and observable through Langfuse with a 30-task UCC-bench as its regression net.

Delivered in phases, **Phase 1 (foundation)** is already achievable inside the current repo shape and unlocks everything else.

---

## 2. What the research said (one paragraph each)

- **Q1 — Competitor architectures** ([01-competitor-architectures.md](./01-competitor-architectures.md)): Lovable, v0, Bolt, Replit Agent, Cursor Agent, Claude Code, and Windsurf all converge on **hydration-style loops** — a cheap planner / router that decides which context to pull and a stronger executor that writes code. Most use full-file rewrite or structured search-and-replace for edits; Claude Code and Cursor use `apply_patch`. System prompts emphasise parallel tool use, safety, and a "no narration — just act" style. **Preview is a killer feature** but depends on an in-environment runtime (Bolt's WebContainers, Replit's Nix sandbox). None train the API into the model — all inject docs on demand.
- **Q2 — Models** ([02-model-selection.md](./02-model-selection.md)): The top tier in 2026 for agentic coding: **Claude Opus 4.5 / Sonnet 4.5**, **GPT-5 / GPT-5 Codex**, **Gemini 2.5 Pro**. Best specific roles: **Planner → Claude Opus 4.5** (best at tool-call planning and multi-step reasoning), **Executor → GPT-5 Codex** (best at producing working Python / configs), **Router/context-selector → Claude Sonnet 4.5** (cheap + reliable JSON tool use). Estimated ≈$0.56 per full session. All three are on OpenRouter.
- **Q3 — Tool design** ([03-tool-design-patterns.md](./03-tool-design-patterns.md)): Prefer **`apply_patch` + structured edits** over full-rewrite for anything longer than ~50 lines; keep full-rewrite for create-only paths. Add an **explicit `TodoWrite` tool** and keep the todo list visible to both agent and user. Use **subagents (`Task`)** for narrowly-scoped sub-problems (e.g., "produce a validated `globalConfig.json` entity from this spec"). Keep and extend **domain-specific tools** (`add_config_entity`, `generate_input_script`, `validate_globalconfig`) because they enforce schema.
- **Q4 — RAG** ([04-rag-strategy.md](./04-rag-strategy.md)): Hybrid RAG wins over pure large-context. Use **voyage-3-large** (or `text-embedding-3-large` as fallback) with **structure-first, stanza-level chunking** for `.conf` spec files. Build **domain-specific fact retrieval tools** (`get_stanza_spec`, `get_rest_endpoint`, `example_addon_matching`) alongside generic vector search. Three-tier knowledge: baked-in minimal prompts → on-demand RAG via `consult_docs` → pinned examples from vetted add-ons.
- **Q5 — UX for non-devs** ([05-ux-patterns.md](./05-ux-patterns.md)): Default to **plain-English summaries**, hide diffs behind a toggle. Two-tier approval: auto-run reads + validators, prompt for writes / builds / runs. Show plans both inline and in a persistent sidebar. When stuck, **admit it and offer options** (retry / change approach / ask a human). Persist **per-project decisions** in an auto-loaded `.agent-memory.md`.
- **Q6 — Security + eval** ([06-security-and-eval.md](./06-security-and-eval.md)): SaaS tier → **Firecracker / gVisor per session** with an ephemeral `tmpfs` workspace; self-host → path validation + `openat2`. Defend against prompt injection with **spotlighting + a DeBERTa classifier** on fetched docs and user SPL. Build a **30-task UCC-bench** scored on syntax, ingestion, AppInspect. Wire **Langfuse** as the trace sink and snapshot-test tool-call sequences for regression.

---

## 3. Target architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                               Browser UI                                   │
│  ┌──────────────┐  ┌────────────────────┐  ┌──────────────────────────┐   │
│  │ File Browser │  │ Monaco Editor       │  │ AIChatPanel              │   │
│  │              │  │ (+ DiffEditor)      │  │  - chat                  │   │
│  │              │  │                     │  │  - plan / todo sidebar   │   │
│  │              │  │                     │  │  - approval prompts      │   │
│  │              │  │                     │  │  - memory tab            │   │
│  └──────────────┘  └────────────────────┘  └──────────────────────────┘   │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │ WebSocket / SSE
┌───────────────────────────────────▼───────────────────────────────────────┐
│                         Node.js Orchestrator                              │
│  ┌────────────────┐  ┌──────────────────┐  ┌───────────────────────────┐ │
│  │ Session Store  │  │ Agent Loop        │  │ Tool Dispatcher           │ │
│  │ (VFS + memory) │  │ - Planner (Opus)  │  │  - file tools (patch etc) │ │
│  │                │  │ - Executor (GPT5) │  │  - domain tools (UCC)     │ │
│  │                │  │ - Router (Sonnet) │  │  - RAG tools              │ │
│  └────────┬───────┘  └──────┬───────────┘  └──────────┬────────────────┘ │
│           │                 │                          │                  │
│           │                 │                          │                  │
└───────────┼─────────────────┼──────────────────────────┼──────────────────┘
            │                 │                          │
            ▼                 ▼                          ▼
    ┌───────────────┐  ┌──────────────┐          ┌────────────────────┐
    │ Langfuse      │  │ OpenRouter   │          │  Sandbox runner    │
    │ (traces,      │  │ (Opus/Sonnet │          │  - Firecracker VM  │
    │  evals, cost) │  │  / GPT-5)    │          │  - ucc-gen         │
    └───────────────┘  └──────────────┘          │  - splunk container│
                                                 │  - AppInspect      │
                                                 └────────────────────┘
                                                          │
                                                          ▼
                                          ┌───────────────────────────┐
                                          │ Pinecone / Turbopuffer    │
                                          │  - globalConfig schema    │
                                          │  - .conf specs            │
                                          │  - splunklib signatures   │
                                          │  - canonical add-ons      │
                                          └───────────────────────────┘
```

### 3.1 Loop shape (planner + executor + router)

```
user message
   │
   ▼
┌──────────────────────┐
│ Router (Sonnet 4.5)  │  selects relevant files, docs, memory
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Planner (Opus 4.5)   │  emits/updates TodoWrite list
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Executor (GPT-5 Codex│  executes one todo at a time:
│  in a tool-call loop)│   read/patch/validate/build
└──────────┬───────────┘
           │  on failure / ambiguity
           ▼
┌──────────────────────┐
│ Back to Planner      │  re-plan or ask the user
└──────────────────────┘
```

A single **turn** for the user can span many executor tool calls but remains one conceptual plan.

### 3.2 Tool library (target)

Grouped by category — ★ = new, ◎ = existing, keep, ➜ = existing, upgrade.

**File editing (edit precision matters):**
- ◎ `list_files` — unchanged.
- ◎ `read_file` — unchanged.
- ★ `apply_patch` — unified-diff-style patch applied via 3-line-context match (a la Aider / Claude Code). Preferred for any edit.
- ★ `create_file` — for new files only. Rejects if file exists.
- ➜ `write_file` — kept as a last-resort full-rewrite; agent told to prefer `apply_patch` / `create_file`.

**Planning + delegation:**
- ★ `todo_write` — replace / update a structured plan shared with the UI.
- ★ `task` — launch a scoped sub-agent (e.g., "produce a validated `inputs` entity for this spec"), returns a single assistant message.

**Domain tools (Splunk UCC):**
- ◎ `add_config_entity` — unchanged; still the safest way to add entities to `globalConfig.json`.
- ◎ `generate_input_script` — unchanged; produces a first-pass Python modular input.
- ★ `validate_globalconfig` — runs the UCC validator on the in-memory doc; returns structured errors.
- ★ `run_btool_check` — runs `btool check` on `.conf` files in the sandbox.
- ★ `run_appinspect` — runs AppInspect in the sandbox; returns check results.
- ★ `build_and_preview` — `ucc-gen` + spin up short-lived Splunk container + return logs / UI URL. (Phase 2.)

**Knowledge / RAG:**
- ➜ `consult_documentation` — upgrade from current shim to a real vector search over the UCC knowledge base (see §3.3).
- ★ `get_stanza_spec` — deterministic lookup for a named stanza in `inputs.conf.spec` / `props.conf.spec` etc.
- ★ `get_rest_endpoint` — deterministic lookup for a Splunk REST endpoint.
- ★ `example_addon_matching` — retrieves a vetted example add-on matching the user's goal (e.g., "REST API polling with OAuth").
- ◎ `get_splunklib_help` — unchanged.

**Memory:**
- ★ `record_decision` — append to `.ucc-agent/decisions.md` with rationale.
- ★ `read_memory` — read `.ucc-agent/decisions.md` (also auto-injected on session start).

### 3.3 Knowledge layer (self-host first — no external services)

Three tiers, all local:

1. **Baked-in system prompt** — ~6 KB. "What UCC is", list of tools, memory contents, current file. **Plus the full `globalConfig.json` JSON Schema** (it's only ~6 KB).
2. **Deterministic conf-spec index** — at startup, parse every `.conf.spec` file shipped with Splunk 10.2 into an in-memory map: `{ confName: { stanzaName: { settingName: { type, default, doc } } } }`. Expose via tools:
   - `get_stanza_spec(conf, stanza)` — returns full setting list.
   - `list_stanzas(conf)` — returns available stanzas.
   - `get_setting(conf, stanza, setting)` — returns a single setting's spec.
   No embeddings, no vector search. Fast, zero-dep, deterministic.
3. **Keyword index (FlexSearch, pure JS)** — canonical UCC add-ons (AWS, Azure, Okta, etc.) and the Splunk REST API spec. Retrieved via `consult_documentation(query, kind?)` on demand. FlexSearch is pure JS with no binary deps.

Optional upgrade path (self-hoster opt-in, unchanged tool API):
- `sqlite-vec` + local ONNX embeddings (bge-m3, nomic-embed). Same tool names, different backend.

**No Pinecone, no Voyage API, no external services.**

### 3.4 Model routing

Default is **single-model Kimi K2.6** (SOTA open-source, 80.2% SWE-bench Verified, available via OpenRouter and runnable locally via Ollama).

Configurable via `MODEL_PROFILE`:

| Profile | Planner | Executor | Router |
|---|---|---|---|
| `kimi-single` *(default)* | `moonshotai/kimi-k2.6` | `moonshotai/kimi-k2.6` | `moonshotai/kimi-k2.6` |
| `anthropic-multi` | `anthropic/claude-opus-4.5` | `anthropic/claude-sonnet-4.5` | `anthropic/claude-haiku-4.5` |
| `openai-multi` | `openai/gpt-5` | `openai/gpt-5-codex` | `openai/gpt-5-mini` |
| `local-ollama` | `ollama:kimi-k2.6:Q2_K_XL` | `ollama:kimi-k2.6:Q2_K_XL` | `ollama:kimi-k2.6:Q2_K_XL` |

User can also override any individual role via `MODEL_PLANNER`, `MODEL_EXECUTOR`, `MODEL_ROUTER` env vars or per-session in Settings. Server respects `OPENROUTER_API_KEY` (legacy `OPENROUTER_APIKEY` also supported) and falls back to user-supplied keys in the browser.

### 3.5 UX (non-developer-first)

- **Default view**: plain-English summary of each action ("I added a new REST input called `github_audit` and wired it to the auth section").
- **Toggle**: "Show code" reveals the diff / new file in an inline Monaco DiffEditor.
- **Plan sidebar**: live todo list from the Planner's last `todo_write`.
- **Approval prompts**:
  - Auto-run: `list_files`, `read_file`, `get_*`, `consult_documentation`, validators.
  - Prompt: `apply_patch`, `create_file`, `write_file`, `build_and_preview`, `run_appinspect`.
  - Allowlist togglable per-project ("don't ask me again for edits in `package/`").
- **Memory tab**: list of decisions, each editable. Visible and easy to forget.
- **Stuck detector**: after 3 consecutive tool failures or 8 turns with no todo progress → agent pauses and surfaces options.

### 3.6 Safety

- **Self-host**: `validatePath` already present. Add `openat2`-backed write in Node (`fs.promises.open` with `O_NOFOLLOW`).
- **SaaS**: Firecracker microVM or gVisor container per session. Project files on ephemeral `tmpfs`. `ucc-gen`, Splunk container, AppInspect all run inside the same VM.
- **Prompt-injection pipeline**:
  - Wrap all external content (fetched docs, user SPL, user prompts that look like tool instructions) in `<untrusted>` tags — spotlighting.
  - Run a lightweight DeBERTa-v3 injection classifier on any retrieved doc chunk.
  - Strip `<tool_call>`-lookalikes from user input.

### 3.7 Observability + evals (simple first)

- **Local JSONL traces** — `.ucc-agent/traces/<session_id>.jsonl`, one line per tool call. Includes prompts, arguments, outputs (hash-truncated for secrets), tokens, cost, latency.
- **Trace viewer tab** in the UI, reads from the same JSONL file.
- **Langfuse optional** — behind a `LANGFUSE_HOST` env var. No-op when unset. Zero dependency on any external SaaS.
- **UCC-bench v0** — 5 scripted tasks in `eval/ucc-bench/`. Each task has `task.md`, `expected/`, `grade.py`. CLI runner. Community-extensible. CI smoke-runs it on PRs.
- **Snapshot tests** — record reference tool-call sequences per task; diff on PR (Phase 2).

---

## 4. Phased roadmap

### Phase 1 — Foundation (this PR + next 1-2 weeks)

Scope:
1. **Branch** — `feat/agent-rebuild` (created).
2. **Tool registry upgrade** — add `apply_patch`, `create_file`, `todo_write`, `task`. Keep `write_file` as fallback. Add unit tests.
3. **Agent loop** — refactor `AIChatPanel` to use a server-side orchestrator (new `server/agent/` module) exposing a streaming endpoint. Introduce explicit Planner / Executor / Router seams, even if all three run the same model for day one.
4. **Memory** — auto-load `.ucc-agent/decisions.md` into every system prompt; expose Memory tab.
5. **Approval UX** — move approval policy from scattered hard-coded to a single `approvalPolicy` config; allow per-tool per-project overrides.
6. **Eval harness scaffolding** — `eval/ucc-bench/` directory with a runner, one sample task, CI job that runs it on PRs.
7. **Observability** — wire Langfuse SDK, gated by `LANGFUSE_HOST` env; no-op if unset.

Deliverables:
- PR against `feat/agent-rebuild` with all of the above.
- Research docs (this directory) checked in for reference.
- `ROADMAP.md` updated.

### Phase 2 — Intelligence (weeks 2-4)

1. **RAG ingestion** — build the Pinecone index for globalConfig schema + `.conf` specs + splunklib + 20 canonical add-ons. Voyage embeddings.
2. **New tools**: `get_stanza_spec`, `get_rest_endpoint`, `example_addon_matching`, `validate_globalconfig`.
3. **Multi-model routing** — Router = Sonnet 4.5, Planner = Opus 4.5, Executor = GPT-5 Codex. Per-user override.
4. **UCC-bench v1** — 30 tasks, CI integration, grade reports stored in Langfuse.

### Phase 3 — Preview + SaaS hardening (weeks 4-8)

1. **Sandboxing** — Firecracker (or gVisor + Docker) per session on the SaaS backend. `ucc-gen` + Splunk container run inside.
2. **`build_and_preview` tool** — streams logs back to the chat; surfaces a Splunk Web URL for the user to click.
3. **Prompt-injection pipeline** — spotlighting + DeBERTa classifier on all retrieved content.
4. **AppInspect integration** — `run_appinspect` tool; block deploy on critical failures.

### Phase 4 — Polish + moat (weeks 8-12)

1. **Canonical add-on library curation** — 20 → 50, with domain-expert review.
2. **Regression snapshot tests** — record reference traces, diff on PR.
3. **"Explain this Splunk concept" conversational flow** — for truly-new users, a guided path that converts goals to configs without them ever reading SPL.
4. **Public UCC-bench leaderboard** — marketing + evidence of quality.

---

## 5. Concrete changes in this PR (Phase 1)

Scope for the initial implementation sprint:

- [ ] `server/agent/` — new module: Planner / Executor / Router seams, SSE / WebSocket endpoint.
- [ ] `src/lib/ai/tools/applyPatch.ts` — unified-diff tool with 3-line-context fuzzy match + reject handling.
- [ ] `src/lib/ai/tools/createFile.ts` — create-only.
- [ ] `src/lib/ai/tools/todoWrite.ts` — structured plan tool.
- [ ] `src/lib/ai/tools/task.ts` — delegates to a sub-agent scoped by `context` argument.
- [ ] `src/lib/ai/tools/recordDecision.ts` + `readMemory.ts` — append / read `.ucc-agent/decisions.md`.
- [ ] `src/lib/ai/approval.ts` — single source of truth for auto-vs-prompt policy; per-project overrides in `localStorage` → synced to server for SaaS.
- [ ] `src/lib/ai/modelRoutes.ts` — role → model map; env-overridable.
- [ ] `src/components/AIChatPanel.tsx` — extract `PlanSidebar`, `MemoryTab`, `ApprovalPrompt` subcomponents; add "Show code" toggle.
- [ ] `eval/ucc-bench/` — scaffolding + 1 sample task + runner + CI job.
- [ ] `server/agent/observability.ts` — Langfuse SDK, no-op without env.
- [ ] `ROADMAP.md` — marked Phase 5 in progress; link to this plan.

---

## 6. Open questions — answered

Per user direction on Nov 22 2026, the open questions are resolved in favour of **self-hostability and simplicity**. Details in [07-oss-agents-and-kimi.md](./07-oss-agents-and-kimi.md).

| Q | Resolution |
|---|---|
| SaaS infra (Firecracker vs gVisor) | **Deferred to Phase 3.** MVP runs on plain Node + Docker. |
| RAG index (Pinecone vs Turbopuffer) | **Neither.** Local deterministic parse of `.conf` specs + FlexSearch keyword index over canonical examples. No external vector DB. |
| Langfuse self-host vs cloud | **Neither required.** Local JSONL traces in `.ucc-agent/traces/`. Langfuse becomes an optional pluggable sink. |
| Budget ceiling | Set a soft cap at $1/session in config; warn user on approach. |
| UCC-bench authorship | Ship with 5 tasks; design for community contribution. |

## 7. Model choice — single-model Kimi K2.6 default

User has explicitly asked we evaluate **Kimi K2.6** as the base. Research confirms it scores SWE-bench Verified 80.2% (matches Claude Opus 4.6), is strong on tool use, costs ~$0.57/M input on OpenRouter, and can be run locally (Ollama, llama.cpp) on RTX 4090+ or Mac M-series 64 GB+.

**Decision:**
- **Default model for all three roles = `moonshotai/kimi-k2.6`** via OpenRouter.
- Keep Planner / Executor / Router seams in code so self-hosters can swap in local Ollama or multi-provider routing.
- Ship a `MODEL_PROFILE` env: `kimi-single` (default) | `anthropic-multi` | `openai-multi` | `local-ollama`.
- Never hard-code "we need Claude / GPT-5 to work".

## 8. Testing focus — verifiable end-to-end

The agent must be able to prove the app it generated works:

- **Playwright E2E** for the builder IDE + chat itself (CI).
- **Agent-callable build + install tools** so the agent closes the dev loop:
  - `run_ucc_gen` — `ucc-gen build` in-sandbox, returns tarball + stderr.
  - `run_appinspect` — AppInspect against the tarball, returns structured check results.
  - `install_to_splunk_docker` — start / reuse a local Splunk container, copy the tarball in, restart Splunk, return web URL + log tail.
  - `browser_check` — headless Playwright that opens `https://localhost:8000`, navigates to the add-on setup page, and asserts no console errors / no red banners.

These are Phase 1 must-haves, not Phase 3 nice-to-haves.
