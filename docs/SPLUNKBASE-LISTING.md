# Splunkbase listing copy — UCC App Builder

Drafted 2026-07-23 for the v0.1.0 Splunkbase submission (native Splunk app,
`splunk-app/`, app id `ucc_app_builder`). Splunkbase's exact field names/limits
can shift — check the live submission form and trim to fit, but this covers
every field it's asked for historically.

## App name

UCC App Builder

## Summary (short description — aim for ~200 characters, shown on tiles/search)

> An agentic Splunk add-on builder: describe it in chat, and a tool-calling AI
> agent authors it, builds with ucc-gen, runs AppInspect and self-corrects
> until the package is clean.

(190 characters)

## Categories

Pick the closest 2–3 from the dropdown at submission time. Best fits, in order:

1. **DevOps**
2. **Artificial Intelligence**
3. **Utilities**

## Supported Splunk platform

- Splunk Enterprise — verified live on **10.4** (build engine targets the
  Python 3.13 runtime; the UCC Configuration REST handlers run under the
  persistent-handler Python, 3.9 on the verified instance)
- Splunk Cloud — MCP tool auto-registration is Cloud-aware (native
  synced-apps registrar reads `tools.conf`), but **this app has not yet been
  vetted for the Cloud AppInspect tag** — flag it as Enterprise-first at
  submission rather than claiming full Cloud support until that vetting's
  done; the app bundles compiled third-party wheels (`pydantic-core`, `grpcio`
  via `mcp`/`langgraph`) which are the usual sticking point for Cloud vetting.
- Requires outbound HTTPS from the search head to your chosen LLM provider's
  API (and to GitHub, only if you use the GitHub push integration)

## Pricing / support type

- Free, Apache-2.0 licensed
- Support: Developer Support (community, via GitHub issues) — not Splunk
  Support
- **Third-party data disclosure (important — surface this explicitly in the
  listing, not just buried in the README):** this app sends data to whichever
  LLM provider you configure (OpenRouter, OpenAI, Anthropic or Google) using
  an API key you supply. That includes your add-on descriptions/spec, file
  contents the agent edits, and — only if you approve it — live Splunk
  metadata (index/sourcetype names, SPL) used to ground suggestions; those
  live-Splunk tools default to **ask-first-use, read-only**. No AI call is
  made, and no data leaves the instance, unless you configure a provider key.

## Full description

Building a Splunk add-on that actually passes **AppInspect** is normally a
slow, expert-only loop: scaffold with `ucc-gen`, package it, run
`splunk-appinspect`, read the findings, hand-fix the source, rebuild,
re-inspect — repeat. UCC App Builder closes that loop with a tool-calling AI
agent: you describe the add-on in chat, the agent edits the source files,
grounds the design in your **live Splunk** (real indexes/sourcetypes/SPL, via
read-only MCP tools you approve), then **builds → runs AppInspect →
self-corrects → repeats until the package is AppInspect-clean**, showing the
whole trace inline as it goes.

It ships as a fully self-contained native Splunk app — no Node sidecar.
Everything the embedded IDE needs (build, AppInspect, the LLM proxy, an input
emulator) runs in Splunk's own Python via persistent REST handlers, with
`ucc-gen` and AppInspect vendored into the app itself.

**Two ways to use it**

1. **Conversationally, in the embedded IDE** — a Monaco-editor UI with
   `.conf.spec` IntelliSense and live validation, ghost-text inline AI
   completion, and an **Expert Expansion review gate**: a one-line request
   becomes a complete, editable UCC spec (inputs, auth + encrypted secrets,
   proxy/logging, sourcetypes, checkpoints, CIM) that you can review *before*
   the agent builds, so it can't ship a thin add-on.
2. **Via MCP, from any agent** — the builder's own tools
   (`create_addon`/`add_input`/`validate_app`/`package_app`) are exposed as
   Splunk MCP Server tools, registered automatically on install (Splunk Cloud's
   native synced-apps registrar on Cloud, a self-registering handler on
   Enterprise). Point the Splunk AI Assistant, Claude Desktop, or any other
   MCP client at your Splunk instance and it can build an add-on
   conversationally too.

**Key features**

- **Self-correcting build loop** — generate (`ucc-gen`) → `splunk-appinspect`
  → parse actionable findings → fix (deterministic rules first, LLM for the
  rest) → repeat, with the full trace surfaced live.
- **Live-Splunk grounding, safely gated** — read-only tools
  (`get_live_indexes`, `get_splunk_metadata`, `run_splunk_query`,
  `generate_spl`) default to **ask-on-first-use, remembered for the session**;
  every external/agent tool has an explicit auto/ask/deny policy, overridable
  per tool in Settings.
- **In-app "App Builder Advisor"** running on the Splunk Agent SDK
  (`splunklib.ai`) — `POST /services/ucc_app_builder/advisor` authors
  `globalConfig.json`, runs the build+inspect loop, and self-corrects, all
  inside Splunk.
- **One key, configured the Splunk way** — pick a provider (OpenRouter,
  OpenAI, Anthropic or Google) under Configuration → AI Provider, paste the
  key once; it's stored encrypted in `storage/passwords` and shared by both
  the chat UI and the Advisor. Per-function model + temperature (chat/agent,
  the AppInspect fixer, inline completion).
- **CI/CD generation** — connecting a built add-on to GitHub can emit a
  ready-to-run `build-validate.yml` (ucc-gen build + AppInspect).
- **Path-confined agent** — file access is scoped per user to that user's own
  add-on project; the agent can never touch the Splunk filesystem outside it.

**Why**

Most people who'd benefit from a Splunk add-on don't know `ucc-gen`
regenerates `app.conf`/`inputs.conf` on every build, so their manual fixes get
silently overwritten and they go in circles. UCC App Builder gives them (and
experienced developers who just want to move faster) a build loop that
verifies itself against AppInspect instead of guessing.

**Requirements**

- Splunk Enterprise 9.x+ (verified on 10.4)
- An API key from a supported LLM provider to use any AI feature (OpenRouter
  recommended — one key, many models); without a key the app still installs,
  the IDE opens, but AI features are inactive
- Outbound HTTPS from the search head to that provider's API

## Setup / installation instructions field

1. Install the packaged app (**Apps → Manage Apps → Install app from file**).
2. Open **UCC App Builder → Configuration → AI Provider**. Choose a provider
   (OpenRouter recommended), paste your API key, and set the model +
   temperature for chat/agent, the AppInspect fixer, and inline completion.
3. From the home page, describe the add-on you want in chat — or use
   **Expert Expansion** to turn a one-line request into a full, editable UCC
   spec (inputs, auth, encrypted secrets, proxy, sourcetypes, CIM) to review
   before anything is built.
4. Let the agent build: it runs `ucc-gen`, then AppInspect, and self-corrects
   until the package is clean — the trace shows live in the IDE.
5. The first time the agent wants to use a live-Splunk grounding tool
   (indexes/sourcetypes/SPL) or another external tool, approve it once
   (Approve / Approve for session / Deny); tune the default per tool under
   Settings.
6. Optional: connect the generated add-on to GitHub to push it and get a
   ready-to-run `build-validate.yml`.
7. Optional: point any MCP client (Splunk AI Assistant, Claude Desktop, etc.)
   at this Splunk instance — the builder's tools are already registered.

## Release notes (v0.1.0 — initial public release)

- Native Splunk app packaging (no Node sidecar); ucc-gen + AppInspect vendored
  into the app for in-Splunk builds.
- Self-correcting build agent: ucc-gen → AppInspect → fix → repeat, with live
  trace.
- Two Splunk-AI integrations: builder tools exposed as MCP Server tools
  (auto-registered on Cloud and Enterprise), plus an in-app Advisor on the
  Splunk Agent SDK (`splunklib.ai`).
- Monaco IDE: `.conf.spec` IntelliSense + live validation, ghost-text inline
  AI completion, Expert Expansion review gate before build.
- Tool-approval handshake for external/live-Splunk tools (auto/ask/deny,
  per-tool, remembered per session).
- One encrypted credential (`storage/passwords`) shared across both AI
  surfaces; per-function model configuration.
- CI/CD generation for produced add-ons (`build-validate.yml`).
- Path-confined file access per user/project.
- AppInspect-clean packaging fixes baked in (solnlib 7.x pin to avoid
  AArch64-incompatible native deps, UCC `password`-type field mapping, no
  stray `metadata/local.meta`).

## Support / links

- Source, issues, documentation: https://github.com/livehybrid/ucc-app-builder
- License: Apache-2.0

## Screenshots to upload

From `docs/screenshots/`:

- `01-wizard-review.png` — the Expert Expansion review gate (suggested
  caption: *"Review the full UCC spec — inputs, auth, sourcetypes, CIM —
  before the agent builds anything."*).
- `02-ai-chat.png` — the chat agent building an add-on (suggested caption:
  *"Describe the add-on you want in plain language."*).
- `03-build-loop-mid-trace.png` — the self-correcting build loop mid-run
  (suggested caption: *"Watch the agent build, run AppInspect, and fix
  findings live."*).
- `04-build-loop-clean.png` — an AppInspect-clean result (suggested caption:
  *"AppInspect-clean, automatically."*).
- `05-preview-ui.png` — the Monaco IDE / preview UI (suggested caption:
  *"A full Monaco-based editor with spec IntelliSense and inline AI
  completion."*).
