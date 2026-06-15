# Research Q7 — Open-source coding-agent repos + Kimi K2.6 deep dive

> Source: Perplexity Pro (Nov 2026).
> Intent: keep self-hosting simple. Avoid external services. Evaluate Kimi K2.6 as a potential single-model base.

## 1. OSS coding-agent repos worth borrowing from

After triaging the field, five are clear leaders for 2026:

### OpenHands / All Hands AI  *(Python primary, TS frontend)*
- **Loop**: modular, abstract `Agent` class with `step(state)` — reason / act / observe cycle. Native subagent and MCP support.
- **Edit tools**: sandboxed runtime (`apply_patch`-ish), terminal, web browsing.
- **Reusable ideas**: tool registry with MCP integration (`set_mcp_tools`); streaming parser via LiteLLM; prompt manager + event stream as the planner/executor seam.
- **For us**: deepest agentic patterns to copy. The `Agent.step(state)` shape maps directly onto our target Planner → Executor → Router.

### Aider  *(Python)*
- **Loop**: repo maps (AST-based indexing) drive iterative plan / edit / test.
- **Edit tools**: the canonical `apply_patch` fuzzy-matcher; tight git integration; avoids reading the whole codebase.
- **Reusable ideas**: lightweight tool registry for bash + editor; robust LLM-output parsing; map-reduce planner.
- **For us**: the **apply_patch implementation to port**. Aider's fuzzy match + reject-hunk behaviour is the de-facto standard.

### Continue.dev  *(TypeScript / Node, VS Code extension)*
- **Loop**: agent-mode sends all tools to LLM; user approves each tool call (`edit_existing_file`, `run_terminal_command`).
- **Edit tools**: granular edits with permission gates.
- **Reusable ideas**: `all-tools` list (tool registry pattern), streaming support, executor via chat requests.
- **For us**: **TypeScript-native — the tool registry and streaming layer are directly borrowable** into our Node stack.

### Cline  *(TypeScript, VS Code)*
- **Loop**: autonomous agent with per-action approvals (edits, terminal, browser).
- **Edit tools**: granular file diffs.
- **Reusable ideas**: BYOK tool registry; streaming rules; planner with task behaviours.
- **For us**: the approval UX + "rules file" pattern transfer directly.

### bolt.diy  *(TypeScript / Node, browser-based, open-source Bolt.new)*
- **Loop**: prompt → run → edit → deploy, with integrated terminal.
- **Edit tools**: git revert as the "undo" primitive.
- **Reusable ideas**: extensible LLM tool registry via **Vercel AI SDK**, streaming parser, full-stack executor.
- **For us**: the Vercel AI SDK pattern is how to get multi-provider support for cheap.

### Skip-list (dated or overlapping)
Goose (Block), gpt-engineer, Devika, smol-developer, Kilo Code, Roo Code — niche or stale in 2026 sources.

## 2. Kimi K2.6 (Moonshot AI, Nov 2026)

### Benchmarks (public)
| Benchmark | K2.6 score | Notes |
|---|---|---|
| **SWE-bench Verified** | **80.2%** | Tops open models; matches Claude Opus 4.6 |
| **SWE-bench Pro** | 58.6% | |
| **Terminal-bench 2.0 (Terminus-2)** | 66.7% | |
| **tau-bench** | n/a | Not in 2026 sources; HLE-with-tools agentic aggregate is 54.0% |

### Tool-calling reliability
Strong in agentic tasks — **outperforms GPT-5.4 on SWE-Pro / Terminal-bench**, competitive with Claude Sonnet 4.5 successors (Opus 4.6 tier). Community reports describe it as "reliable / pragmatic" vs. GPT-5 Codex (thorough) and Sonnet (fast but regressions).

### Local viability via Ollama
- **Open weights, 1T parameters**.
- `UD-Q2_K_XL` quantisation with llama.cpp (MoE offload) gives "world-class" quality.
- Hardware floor: **RTX 4090+** or Apple-silicon Mac **M-series with ≥64 GB unified memory**.
- Still big — not a laptop-friendly model. But truly self-hostable on prosumer / workstation hardware.

### OpenRouter availability
Yes. Priced around `$0.57 per 1M input tokens` (same tier as Kimi K2).

### Viable as a single-model base?
**Yes.** Its SOTA open-source agentic coding scores make it a strong single-model choice vs. multi-model routing, particularly when local operation is a goal. It is competitive with (not worse than) the Opus+GPT-5 stack for our workload shape.

## Decisions (driven by user feedback)

User wants the app to stay easy to self-host and avoid external services. That reshapes the plan:

1. **Default model = Kimi K2.6** via OpenRouter.
   - Single-model design, no Planner/Executor/Router split at runtime.
   - Keep the **role seams in code** (so we can swap in multi-model routing if a self-hoster wants), but run all three roles on K2.6 by default.
   - Provide a `MODEL_PROFILE` env: `kimi-k2.6-single` (default) | `anthropic-multi` | `openai-multi` | `local-ollama`.
   - Users who want to go local set `OLLAMA_BASE_URL` + `OPENROUTER_API_KEY=""`.

2. **No Pinecone. No external vector DB.** Three-layer local knowledge instead:
   - **Tier 1 (deterministic, no embeddings):** parse the Splunk `.conf.spec` files into an in-memory index at startup. Expose `get_stanza_spec(conf, stanza)` / `list_stanzas(conf)` / `get_setting(conf, stanza, setting)`. No search needed — the agent knows the stanza names.
   - **Tier 2 (in-prompt for small domains):** the `globalConfig.json` JSON Schema is only ~6 KB. Load it straight into the system prompt.
   - **Tier 3 (keyword search with no embedder):** canonical add-on examples + Splunk REST docs indexed with **FlexSearch** (pure-JS, no binaries). Returns top-N docs by keyword relevance. Optional; agent only calls it when Tier 1/2 don't cover the question.
   - If a self-hoster *does* want semantic search later, they can drop in `sqlite-vec` with local ONNX embeddings without touching any tool code — the retrieval tool is pluggable.

3. **Observability = local JSONL traces.** No Langfuse requirement.
   - Traces land in `.ucc-agent/traces/<session_id>.jsonl`, one line per tool call, prompts included.
   - Simple `GET /api/agent/traces` endpoint + a trace viewer tab in the UI for debugging.
   - Langfuse becomes an **optional pluggable sink** behind `LANGFUSE_HOST` env — no-op when unset.

4. **Edit tool = Aider-style `apply_patch`** ported to TypeScript, with 3-line-context fuzzy match + reject handling. Keep `create_file` for new files and `write_file` as last-resort.

5. **Tool registry pattern = Continue.dev / Vercel AI SDK shape.** Stays TS-native, fits our Node stack.

6. **Testing focus (user ask):**
   - Playwright E2E tests for the IDE + chat.
   - **Agent-side tools** that let the agent close the dev loop itself:
     - `run_ucc_gen` — runs `ucc-gen build` inside the sandbox.
     - `run_appinspect` — runs Splunk AppInspect against the built tarball.
     - `install_to_splunk_docker` — starts / reuses a local Splunk container, copies the app in, restarts, returns URL + log tail.
     - `browser_check` — headless Playwright run that opens Splunk Web on the running container and verifies the add-on's setup page loads without JS errors.
   - The produced app is therefore **verifiable end-to-end by the agent itself** before it tells the user it's done.

## Key takeaway

Single-model Kimi K2.6 + local-first knowledge + local JSONL observability + Playwright + Docker-install tool gives us a **fully self-hostable agent builder with SOTA quality and zero external service dependencies**. External services become optional upgrades (OpenRouter for easy hosted model access, Langfuse for advanced observability, Pinecone for semantic search) — not requirements.
