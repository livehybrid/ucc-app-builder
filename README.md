# UCC App Builder — an *agentic* Splunk add-on builder

> **Splunk Agentic Ops Hackathon 2026 · Platform & Developer Experience track**

Building a Splunk add-on that actually passes **App Inspect** is a slow, expert-only loop:
scaffold with `ucc-gen`, package it, run `splunk-appinspect`, read the findings, hand-fix
the source, rebuild, re-inspect… repeat. Beginners don't know that ucc-gen *regenerates*
`app.conf`/`inputs.conf` on every build, so they "fix" the wrong file and go in circles.

**UCC App Builder closes that loop with a tool-calling AI agent.** You describe the add-on
in chat; the agent edits the source files with its tools, **grounds the design in your live
Splunk** (real indexes/sourcetypes/SPL via MCP), then **builds → runs `splunk-appinspect` →
self-corrects → repeats until the package is App-Inspect-clean** — surfacing the whole trace
inline as it goes. The same agent also *exposes* its actions as MCP tools so any external
agent (Claude Desktop, the Splunk AI Assistant) can build an add-on conversationally.

## 🚀 Now a native Splunk app — proven live on Splunk Enterprise 10.4

The builder also ships as a **packaged Splunk app** (`splunk-app/`, app id
`ucc_app_builder`) from the **same engine** — two Splunk-AI integrations, both proven
end-to-end on a live instance:

1. **Its builder tools are exposed as Splunk MCP Server tools** (`default/tools.conf` →
   persistent REST handlers, registered into the Splunk MCP Server's `mcp_tools` KV
   registry). Any MCP client — **the Splunk AI Assistant, Claude Desktop, another agent** —
   can build a Splunk add-on by calling tools on Splunk's own MCP server. *Verified live:*
   `ucc_create_addon → ucc_write_file → ucc_list_project → ucc_read_file` with state
   persisting across calls.

2. **An in-app "App Builder Advisor" runs on the Splunk Agent SDK (`splunklib.ai`).**
   `POST /services/ucc_app_builder/advisor {"prompt":"..."}` runs a `splunklib.ai` agent
   (LLM via **OpenRouter**, provider-agnostic) whose local tools are the same builder
   operations; it authors `globalConfig.json`, runs `build_and_inspect`, and self-corrects.
   *Verified live:* "build an add-on called contoso_logs with an api_url field" →
   **AppInspect-clean `ta_contoso_logs-1.0.0.tar.gz` in ~40s**, all inside Splunk.

Both surfaces share one build engine (`server/mcp/core.ts` + `server/services/agentLoop.ts`)
— **no code duplication**. The native app reuses it via a small Node build-engine endpoint;
the standalone app calls it directly. File access is **path-confined per user** in a KV
collection (`builder_common.to_safe_project_path`) — the agent can touch only its own add-on
project, never the Splunk filesystem. Architecture: [`architecture_diagram.md`](architecture_diagram.md);
deep dive + the five SDK-in-Splunk gotchas: [`docs/SPLUNK-APP-PLAN.md`](docs/SPLUNK-APP-PLAN.md);
build/deploy: [`splunk-app/deploy/build_agent_app.sh`](splunk-app/deploy/build_agent_app.sh).

## What's agentic here — one tool-calling agent

The centrepiece is a single **planner/executor tool-calling agent**
(`server/routes/ai.ts` → `POST /api/ai/agent/stream`; reusable loop in
`server/services/agentRunner.ts`). It streams model output, runs tool calls against an
in-memory VFS, feeds results back, and repeats. Its tool belt:

- **Authoring** — read/write/`apply_patch` files, `validate_ucc_conformance`,
  `generate_input_script`, `get_stanza_spec`, todo/decision/memory.
- **MCP grounding** (live Splunk, **read-only**) — `get_live_indexes`,
  `get_splunk_metadata`, `run_splunk_query`, `generate_spl`
  (`server/services/agentTools.ts` → `splunkMcp.ts`). **External access → approval on
  first use** (default policy `ask`, remembered for the session). `AGENT_MCP_GROUNDING=1`
  makes them seamless (`auto`); see [Tool-approval policy](#tool-approval-policy).
- **Verify + self-correct** — `build_and_inspect`
  (`server/services/agentTools.ts` → `agentLoop.ts`): runs the loop below, then syncs the
  corrected source back into the agent's VFS so it can keep fixing until CLEAN.

### Tool-approval policy

Every agent-callable tool has a policy: **`auto`** (run silently), **`ask`** (require
user approval on **first use**, then **remembered for the rest of the session**), or
**`deny`** (refused outright). Safe local/VFS + build tools (read/write/`apply_patch`,
`validate_ucc_conformance`, `build_and_inspect`, …) default to `auto`. **External-access
tools default to `ask`**: the live-Splunk MCP grounding tools plus deploy/external-fetch
tools (`install_to_splunk_docker`, `browser_check`). Resolver: `server/services/toolPolicy.ts`.

- **`AGENT_MCP_GROUNDING` (repurposed).** It no longer *excludes* the grounding tools —
  they are always available. ON → grounding tools become `auto` (seamless); OFF (default)
  → they stay `ask` (available but gated on first use).
- **`AGENT_TOOL_POLICY`.** A JSON map of tool → policy to override individual tools, e.g.
  `AGENT_TOOL_POLICY='{"run_splunk_query":"deny","write_file":"ask"}'`. Invalid JSON is ignored.
- **Per-request overrides.** The **Settings** panel lists the external/`ask` tools with an
  Always-ask ↔ Auto toggle, persisted to `localStorage` and sent as `toolPolicy` with each
  request. Precedence: default < `AGENT_MCP_GROUNDING` < `AGENT_TOOL_POLICY` < per-request.

**Pause/resume handshake.** Before an `ask`-policy tool that isn't yet session-approved
runs, the server emits an `approval_request` SSE frame `{ approvalId, tool, args, reason }`
and **awaits**. The browser renders an approval **card** (Approve / Approve for session /
Deny); the decision is POSTed to **`POST /api/ai/agent/approve`**
`{ approvalId, decision: 'approve'|'approve_session'|'deny' }`, which resumes the run.
`approve_session` remembers the tool for the rest of the session. **Deny** → the agent is
told "Proceed without it" and adapts. A **180s timeout → deny** (`approval_timeout`). The
effective policy map is exposed at `GET /api/ai/config` under `toolPolicy`.

### The correct UCC source model (what the agent authors vs. what `ucc-gen` generates)

`globalConfig.json` is the **core artifact**, authored at the project **ROOT**. The agent
authors **only**:

- `globalConfig.json` (root) — inputs, configuration, UI.
- `package/app.manifest` — **REQUIRED**; `ucc-gen` does NOT generate it. If the agent
  omits it, the build's **deterministic manifest guard** generates a valid one from
  globalConfig metadata (`appManifestFromGlobalConfig()` in `src/lib/generator.ts`) so the
  build never fails for a missing manifest — and is also a build-error fixer rule so the
  flaky LLM "create the manifest" path is never relied on.
- Custom `package/bin/*.py`, `package/lib/requirements.txt`, `package/static/` icons.

`ucc-gen` **generates** `default/*.conf` (incl. `app.conf`/`inputs.conf`), the
modular-input wrappers, the UCC lib, and the UI from globalConfig — the agent must **not**
hand-author those (editing them is silently overwritten on the next build). The system
prompt + the `build_and_inspect` tool description teach the order: author globalConfig →
provide app.manifest → run `build_and_inspect` (generate boilerplate) → THEN implement the
collection logic in `package/bin/`.

### The self-correcting loop the agent drives (`server/services/agentLoop.ts`)

```
generate (ucc-gen build + package)
   → splunk-appinspect (precert)
   → parse actionable checks
   → fix:  deterministic rules first (free), then Claude (LLM) for the rest
   → rebuild from corrected source
   → repeat until clean (or maxIterations)
```

The fixers are **grounded in real ucc-gen semantics**: e.g. `check_for_updates_disabled`
→ set `meta.checkForUpdates=false` in `globalConfig.json` (editing the generated `app.conf`
is silently overwritten on the next build); missing `pages.inputs.table` → synthesise it
from the service's entities; **missing `package/app.manifest`** → generate it from
globalConfig metadata; `check_aarch64_compatibility` → pin `solnlib<8`. A **build-error
no-progress breaker** stops the loop when a fix reports `changed: []` (no-op) AND the build
fails again with the identical error. Every step is traced (SSE + JSONL) and rendered inline
in the chat.

The agent is the **primary surface** (the chat panel). A standalone **AppInspect Loop**
panel (`src/components/LoopPanel.tsx`) exposes the same loop deterministically (no LLM by
default) for a reproducible, offline demo. Both a config-only and an input-bearing
(modular-input) add-on reach **AppInspect-CLEAN deterministically, with no LLM** — see the
recorded traces in [`transcripts/`](./transcripts/).

### Eval bench (the "tested / best-practices" evidence)

`eval/ucc-bench/runner.ts` runs 5 tasks end-to-end against the **same** agent + tools, then
grades **syntax / build / AppInspect** by re-running the production loop. Latest full run
(`anthropic-multi`): **80% pass (4/5)** — **build 100%, AppInspect 100%**, syntax 80% (the
one miss built clean but lacked a required input script). Results land under
[`eval/ucc-bench/results/`](./eval/ucc-bench/results/). Run it:

```bash
npx tsx eval/ucc-bench/runner.ts --dry-run        # validate task defs (no API, CI-safe)
MODEL_PROFILE=anthropic-multi npx tsx eval/ucc-bench/runner.ts   # full run (needs OPENROUTER_API_KEY)
```

See [`architecture_diagram.md`](./architecture_diagram.md) for the full picture, and
[`DEMO-SCRIPT.md`](./DEMO-SCRIPT.md) for the <3-minute storyboard.

### Why the dependency pins (AppInspect-clean packaging)

The generator emits `solnlib>=5.0.0,<8` (and `splunktaucclib>=6.6.0,<9`) into
`package/lib/requirements.txt`. solnlib 8.0.0 added `grpcio`/`opentelemetry` deps that bundle
**AArch64-incompatible native binaries** (`protobuf _upb/_message.abi3.so`, grpc `cygrpc`),
which fail AppInspect `check_aarch64_compatibility`. solnlib 7.x is pure-Python and keeps the
package clean. The generator also maps the wizard/MCP `password` field type to a UCC `text`
entity with `encrypted: true` (UCC has no `password` entity type — passing it through fails
schema validation), never ships `metadata/local.meta`, and avoids non-image files under
`static/`. These are the correctness fixes that make an input-bearing add-on build clean.

## Built, validated & tested by GitHub Actions

Everything ships through CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) —
and the build/validation stages run on **Splunk's own official developer tooling**, the
same tools this app's agent drives at runtime:

| Job | What it proves | Splunk dev tooling used |
|---|---|---|
| `build-test` | typecheck, lint, unit tests, frontend + server build, MCP JSON-RPC smoke | — |
| `loop-smoke` | the agentic loop reaches **AppInspect-CLEAN** end-to-end, deterministically (no LLM) | **`ucc-gen`** (UCC framework) + **`splunk-appinspect`** CLI |
| `splunk-app` | builds the native app and runs an **AppInspect precert** gate (all tags) | **`ucc-gen build`** + **`splunk-appinspect inspect --mode precert`** |
| `official-appinspect-cloud` | **Splunkbase `cloud` certification** via Splunk's official AppInspect Action | **`splunk/appinspect-cli-action@v2.13.0`** — Splunk's own published GitHub Action (the same one the shared **[`livehybrid/deploy-splunk-app-action`](https://github.com/livehybrid/deploy-splunk-app-action)** pipeline wraps across the app portfolio) |
| `splunk-integration` | installs the built app into a **real Splunk (Docker)** and runs 16 asserted REST checks against `splunkd` | Splunk Enterprise container + the app's own MCP-tool REST handlers |
| `licenses` | every bundled library is **open source** (`--check` policy gate); see [`licenses/`](licenses/) | — |
| `e2e` | browser (Playwright) — wizard, AI chat, Build Loop trace to CLEAN | — |

The headline is that **AppInspect (a Splunk Developer Tool) is both the runtime oracle the
agent self-corrects against *and* the CI gate** — validated two ways: our own strict
`precert` run (all checks, with the inherent compiled-deps `check_aarch64_compatibility`
recorded in [`.appinspect.expect.yaml`](.appinspect.expect.yaml)), and Splunk's **official
`splunk/appinspect-cli-action` GitHub Action** for `cloud` certification. The build itself
is **`ucc-gen`**, Splunk's official add-on build framework. That official AppInspect Action
is the very one wrapped by the shared `livehybrid/deploy-splunk-app-action` reusable
pipeline used across the rest of the Splunk-app portfolio (which also offers `appinspect-api`
cloud vetting and Splunkbase `publish` jobs for release).

## In the editor (what you get in the UI)

Beyond the chat agent, the web IDE assists you directly:

- **Preview UI** — renders the current `globalConfig.json` exactly as `ucc-gen` will
  build it: the app's nav bar, the inputs table (with a working "Create New Input"
  form), and configuration tabs, with **field validators running live as you type** —
  so you can check the add-on's UX before any build. Undefined pages are hidden.
- **Monaco editor assists** — `.conf` syntax highlighting + stanza/key **autocomplete**
  and lint (duplicate stanza/key warnings) sourced from bundled Splunk `.conf.spec`
  files; **server-side Python syntax checking** (`ast.parse`, no execution); and
  **live `globalConfig.json` schema validation** served from the installed `ucc-gen`
  package, so the editor and the build engine never drift.
- **ucc-gen 6.5** — the builder tracks the authoritative globalConfig schema from
  `ucc-gen` 6.5.0; the generator and a self-healing build-loop fixer keep generated
  configs valid against 6.5's stricter validation.
- **Continue past max iterations** — if the agent hits its iteration cap, a one-click
  **Continue** button resumes the remaining work.

## How AI is used

- **Self-correcting build agent** — the loop above. The *reasoning* (which findings to fix,
  how) is done by Claude via OpenRouter; `splunk-appinspect`, `ucc-gen` and the Splunk MCP
  Server are its *tools*.
- **Natural-language build agent** — `POST /api/ai/agent/stream` is a Planner/Executor SSE
  agent with VFS tools (read/write/patch files, todos, decisions) for conversational editing.
- **Splunk MCP Server (consume)** — `server/services/splunkMcp.ts` calls
  `splunk_get_indexes` / `splunk_get_metadata` / `saia_generate_spl` so the wizard suggests
  **real** indexes/sourcetypes instead of asking you to guess.
- **Splunk MCP Server (expose)** — `server/mcp/server.ts` is a standalone stdio MCP server
  exposing `create_addon`, `add_input`, `validate_app`, `package_app`.

## Setup

Prerequisites: **Node 20+**, **Python 3.10+**, and the Splunk developer tools on `PATH`:

```bash
pip install splunk-add-on-ucc-framework   # provides ucc-gen (tested: 6.4.0)
pip install splunk-appinspect              # provides splunk-appinspect (tested: 4.2.1)
```

Install JS deps:

```bash
npm install
```

Environment (a `.env` in the repo root, or the workspace root one level up is also read):

```bash
# LLM fixer + chat agent — Claude via OpenRouter:
OPENROUTER_API_KEY=sk-or-...
# Optional: override the fixer model (default anthropic/claude-sonnet-4.5)
UCC_FIXER_MODEL=anthropic/claude-sonnet-4.5

# Optional: hosted GitHub OAuth App Client ID (not a secret). When set, the GitHub
# panel uses it for everyone and hides the field; otherwise users bring their own.
GITHUB_CLIENT_ID=Iv1...

# Optional: ground wizard suggestions in a live Splunk instance via the MCP Server
SPLUNK_MCP_URL=https://<host>:8089/services/mcp
SPLUNK_TOKEN=<bearer-token-scoped-to-/services/mcp>
SPLUNK_MCP_INSECURE=true          # allow self-signed TLS on lab instances

# Live-Splunk MCP grounding policy. The grounding tools (get_live_indexes /
# get_splunk_metadata / run_splunk_query / generate_spl) are ALWAYS available; this flag
# sets their approval policy. OFF (default) → policy `ask` (gated on first use, then
# remembered for the session); ON (1/true/on/yes) → policy `auto` (seamless, no prompt).
# Surfaced at GET /api/ai/config (capabilities.mcpGroundingEnabled + toolPolicy.mcpGroundingAuto).
AGENT_MCP_GROUNDING=0

# Optional: per-tool approval policy overrides (JSON map of tool -> auto|ask|deny).
# Precedence: built-in default < AGENT_MCP_GROUNDING < AGENT_TOOL_POLICY < per-request UI.
# Invalid JSON / values are ignored. Example:
#   AGENT_TOOL_POLICY={"run_splunk_query":"deny","write_file":"ask"}
AGENT_TOOL_POLICY=

# Optional: agent-loop limits (DEFAULTS only — explicit request args still win)
AGENT_MAX_ITERATIONS=12           # planner/executor turns (agentRunner), clamp [1,20]
AGENT_INSPECT_MAX_ITERATIONS=4    # AppInspect self-correct turns (runAgentLoop)
AGENT_NO_PROGRESS_LIMIT=3         # stop after N identical failing/unchanged tool calls (min 2)
```

### Loop safety: the no-progress breaker

The agent will not burn iterations (or OpenRouter spend) going in circles. Two
deterministic breakers stop it the moment it stops making progress:

- **`agentRunner` (planner/executor):** each tool execution is signed by
  `toolName + stable-stringified-args + (errored ? "ERR" : hash(result))`. If the
  **same (tool+args) returns an error or an identical result `AGENT_NO_PROGRESS_LIMIT`
  times in a row** (default 3), the loop stops early, emits a `no_progress` event,
  and returns `stoppedNoProgress: true`. A **Security Error for the same path twice
  breaks immediately** (a sandbox refusal can't be retried into success).
- **`runAgentLoop` (AppInspect self-correct):** if an iteration's findings are
  byte-identical to the previous iteration's, the last fix changed nothing → the
  loop stops ("fix did not change findings") instead of grinding to the cap.

The current defaults are exposed at `GET /api/ai/config` under `agent: {...}`, and
the **Settings panel** in the AI Agent chat has a **"Max agent iterations"** control
(seeded from that endpoint, validated to [1, 20]) that is sent in each agent request.

## Run

```bash
# 1) The keystone loop, as a CLI demo (no UI needed).
#    Builds a deliberately-imperfect add-on, then watches AppInspect go green.
npm run loop            # generate → appinspect → auto-fix → clean (LLM if key present)
npm run loop -- --no-llm     # deterministic fixers only (free, offline)
npm run loop -- --llm-only   # force the Claude fixer (shows UCC-grounded reasoning)
npm run loop -- ./my-project.json   # run on your own { appId, files:[{path,content}] }

# 2) Full app: Vite frontend + Express backend together.
npm run dev:all         # frontend http://localhost:5173, API http://localhost:3001
#    If 3001 is taken: PORT=3011 npm run dev:all, and point the FE at it with
#    VITE_API_URL=http://localhost:3011/api (the build-loop panel uses this base).
#    Then open the UI and click "Build Loop" to drive the agent from a NL spec.

# 3) The builder as an MCP server (stdio) for external agents.
npm run mcp:server      # exposes create_addon / add_input / validate_app / package_app
npm run mcp:smoke       # hermetic JSON-RPC smoke (init→tools/list→create_addon→add_input)
```

### Drive the loop over HTTP (SSE)

```bash
curl -N -X POST http://localhost:3001/api/agent/build-loop \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"demo","appId":"TA_demo","files":[ ...VFS files... ]}'
# events stream as: start, build, inspect, fix, clean/exhausted, done, result
```

### Approve a paused tool (tool-approval handshake)

When the agent stream emits an `approval_request` for an `ask`-policy external tool,
resolve it with the approvalId from that frame:

```bash
curl -X POST http://localhost:3001/api/ai/agent/approve \
  -H 'Content-Type: application/json' \
  -d '{"approvalId":"apr_...","decision":"approve_session"}'
# decision: approve | approve_session (remember for the session) | deny
# 404 if the approvalId is unknown (already settled or timed out → treated as deny)
```

### Live Splunk grounding (when SPLUNK_MCP_URL/TOKEN set)

```bash
curl http://localhost:3001/api/splunk/status
curl http://localhost:3001/api/splunk/indexes
curl 'http://localhost:3001/api/splunk/sourcetypes?index=main'
```

### GitHub integration (push your generated add-on to a repo)

The **GitHub** panel can push the generated add-on to a repository. It authorises
with GitHub's **OAuth Device Flow**, so there is **no env var and no client
secret** — you provide only an OAuth App **Client ID**, entered in the UI (stored
in the browser's `localStorage`, key `splunk_app_builder_github_client_id`).

One-time setup of the OAuth App:

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Fill in any name and homepage URL. For **Authorization callback URL**, any
   valid URL works (e.g. `http://localhost:3001`) — Device Flow doesn't use it.
3. On the created app, tick **“Enable Device Flow”** and **Update application**.
   (This is required — without it GitHub returns `404 Not Found` on the device
   request.)
4. Copy the app's **Client ID** (the `Iv1…`/`Ov23…` value — **not** the client
   secret).

Then in the builder: open the **GitHub** panel, paste the **Client ID**, click
**Connect**, and complete the device-code prompt GitHub shows. The browser proxies
the OAuth calls through the backend (`/api/github/*`) because GitHub's OAuth
endpoints don't send CORS headers.

**Hosted vs bring-your-own Client ID.** Set `GITHUB_CLIENT_ID` in the server env to
provide a hosted OAuth App Client ID for the whole deployment (served at
`GET /api/github/config`). When set, the UI uses it and hides the field; when not,
each user supplies their own in the panel (stored in their browser's localStorage).
The device-flow Client ID is not a secret, so this mirrors the OpenRouter
`serverManaged` pattern without exposing credentials.

Troubleshooting: a *“did not recognise this Client ID”* error means the Client ID
is wrong or the OAuth App doesn't exist; a *“Device Flow is not enabled”* error
means step 3 was skipped.

## Prompt doctor — improve the system prompt from real traces (admin)

The agent writes JSONL traces to `.ucc-agent/traces`. `scripts/prompt-doctor.ts`
mines them for recurring failure modes and (optionally) proposes edits to the
**canonical system prompt** in [`src/lib/ai/systemPrompt.ts`](./src/lib/ai/systemPrompt.ts).
It is an **admin task, run from the CLI** (outside the app UI), and it never
changes the prompt without you reviewing a diff and confirming.

```bash
# 1) Analyse traces and print a ranked gap report. FREE — no LLM, no network.
#    Findings are tagged PROMPT (fixable in the prompt) vs CODE vs INFRA.
npx tsx scripts/prompt-doctor.ts            # add --json for machine output

# 2) Ask an LLM to draft minimal prompt edits for the PROMPT-tagged gaps.
#    Costs a little; writes a reviewable proposal to .ucc-agent/prompt-proposals/.
npx tsx scripts/prompt-doctor.ts --suggest  # --model <id> to override

# 3) Apply a proposal — shows the diff, then asks y/N before writing the prompt
#    (backs up to systemPrompt.ts.bak; refuses if the prompt changed meanwhile).
npx tsx scripts/prompt-doctor.ts --apply .ucc-agent/prompt-proposals/proposal-<ts>.json
```

The deterministic analysis (`server/services/traceAnalysis.ts`) is unit-tested; it
separates prompt-addressable gaps (e.g. runs that hit the iteration cap, repeated
ineffective fixes) from code/infra ones (e.g. a provider 400, an unresolved
`check_aarch64_compatibility`) so only genuinely prompt-fixable issues reach the LLM.

### Agent CLI — run the assistant headlessly

`scripts/agent-cli.ts` drives the **same** planner/executor loop, tools, and system
prompt (`src/lib/ai/systemPrompt.md`) as the in-app chat, from the command line —
so you can test prompt changes quickly and programmatically (tools auto-run; no
approval gate). It reports token usage and writes the resulting VFS to disk on
request.

```bash
npx tsx scripts/agent-cli.ts "Add a modular input that polls a REST API"
npx tsx scripts/agent-cli.ts --model anthropic/claude-sonnet-4.6 --max-iters 8 "…"
npx tsx scripts/agent-cli.ts --seed ./an-app-dir "Make it AppInspect-clean"  # seed the VFS
npx tsx scripts/agent-cli.ts --out ./agent-out "…"   # write the generated files out
npx tsx scripts/agent-cli.ts --json "…"              # machine-readable result on stdout
```

`OPENROUTER_API_KEY` is auto-loaded from the project `.env` then the AIOS root
`.env`. Because it reads the live `systemPrompt.md`, a prompt edit (or a
`prompt-doctor --apply`) is reflected on the very next run.

## Tests & checks

```bash
npm run test:run    # vitest — 305 unit tests (incl. AppInspect policy + clean-package regressions)
npm run typecheck   # tsc --noEmit (frontend)
npm run build:server# tsc -p server/tsconfig.json (backend incl. loop + MCP)
npm run build       # production frontend bundle
npm run ci          # typecheck + lint + tests + build
npm run loop:smoke  # deterministic loop reaches CLEAN (no LLM/network) — exit 0 on clean
npm run mcp:smoke   # MCP server JSON-RPC smoke
npm run test:e2e    # Playwright browser tests (hermetic; mocks all /api/*)
```

CI runs all of the above in [`.github/workflows/ci.yml`](./.github/workflows/ci.yml):
a fast hermetic gate (typecheck/lint/vitest/build/MCP smoke), a `loop-smoke` job that
installs `ucc-gen` 6.4.0 + `splunk-appinspect` 4.2.1 and proves both add-ons reach CLEAN,
and a Playwright `e2e` job.

## Key code map

| Path | Role |
|---|---|
| `server/routes/ai.ts` | **The agent (centrepiece)** — `/ai/agent/stream` Planner/Executor SSE loop; exports `SERVER_TOOLS`. |
| `server/services/agentRunner.ts` | Reusable tool-calling loop (used by the route **and** the eval bench). |
| `server/services/agentTools.ts` | **MCP-as-tools** + **`build_and_inspect`** — the integration seam. |
| `server/services/agentLoop.ts` | The self-correcting loop engine (generate→inspect→fix→repeat). |
| `server/services/appInspect.ts` | splunk-appinspect wrapper + report parsing + fix policy. |
| `server/services/uccGen.ts` | ucc-gen init/build/package wrapper. |
| `server/services/splunkMcp.ts` | Splunk MCP Server client (consume). |
| `server/mcp/server.ts` | Builder exposed as a stdio MCP server. |
| `server/routes/agent.ts` | `/agent/build-loop` (SSE) + ucc-gen/appinspect tool endpoints. |
| `server/routes/splunk.ts` | `/splunk/indexes`, `/splunk/sourcetypes`, `/splunk/generate-spl`. |
| `eval/ucc-bench/runner.ts` | **Eval bench** — runs the agent on 5 tasks, grades syntax/build/AppInspect. |
| `src/components/AIChatPanel.tsx` | **UI: the agent chat (primary surface)** — renders the loop trace inline. |
| `src/components/LoopPanel.tsx` | UI: standalone deterministic AppInspect Loop (same engine, no LLM). |
| `src/lib/specToComponents.ts` | Deterministic NL-spec → UCC project parser (hermetic). |
| `src/lib/generator.ts` | UCC source generator (globalConfig + package/…). |
| `transcripts/` | Recorded proof: config-only + input-bearing loop traces, full MCP session. |

## What's next (deferred)

Scoped out of this round on purpose; the research and target architecture are in
[`docs/research/`](./docs/research/):

- **Two-model planner/executor routing** — distinct planner vs executor models per
  `modelProfile.ts` (the seam exists; the bench currently runs one profile end-to-end).
- **Firecracker / microVM sandbox** for the build+inspect step (today it runs ucc-gen and
  appinspect as child processes on the host).
- **Voyage/embedding RAG** for the docs index (today: local FlexSearch in `localDocsIndex.ts`).
- **Langfuse tracing** for agent runs (today: SSE + JSONL via `traceLogger.ts`).
- **Full 30-task bench** with community-contributed tasks (today: 5 tasks).

## Status & honesty

See [`STATUS.md`](./STATUS.md) for exactly what builds, what's verified end-to-end, what's
stubbed, and what's next.

## License

[Apache-2.0](./LICENSE).
