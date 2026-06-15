# User Guide

A click-by-click tour of the builder's UI: how to start an add-on, what to expect from the
**AI Assistant**, the **Monaco editor** assists (autocomplete + AI tab-completion), and how
to **import/export with GitHub**. For the concepts behind the build, see
[Building add-ons](build_app.md); for the system design, see
[Architecture](architecture_diagram.md).

This guide describes the **native Splunk app** (`ucc_app_builder`). The standalone web app
behaves the same except where noted (the "Seed from installed" feature is native-only).

---

## 1. Getting started - the Home screen

The top nav has three views: **Home**, **Import**, and **GitHub**. Home offers four ways to
start:

| Card | What it does |
|---|---|
| **Build with the AI Agent** | Describe the add-on in plain English; the AI Assistant authors it, builds it, and self-corrects to AppInspect-clean. Start here for "build me a TA that polls X". |
| **Create New App** | Start a blank project and author `globalConfig.json` yourself (with the editor's help). |
| **Import Existing App** | Load an add-on's source - either **seeded from an add-on installed on this Splunk** (native app) or uploaded - to extend it. |
| **Import from GitHub** | Connect to GitHub and clone a UCC add-on's source from a repository. |

**One active project at a time.** Clicking **Create New App** (or starting a new agent
build) **clears** the current project from the per-user store before it begins, so a new app
never inherits the previous one's files.

### Configure your AI provider first (one-time)

The AI Assistant and inline completion need an LLM key. In the native app, open the standard
UCC **Configuration → AI Provider** tab, pick the provider (OpenRouter / OpenAI / Anthropic /
Google), paste the API key, and set the model + temperature. The key is stored **encrypted in
`storage/passwords`** (never in any `.conf`) and is read back by both the in-app chat and the
Agent SDK advisor. You can set **per-function models** - a separate model + temperature for
the **chat/agent**, the **build-loop fixer**, and **inline completion**.

---

## 2. The AI Assistant (chat)

The chat panel is the primary surface. You type a request; a tool-calling agent (running on
the **Splunk Agent SDK**, `splunklib.ai`) edits files, builds, runs AppInspect, and
self-corrects - streaming the whole trace inline.

### What to expect

- **Review first (the spec gate).** Rather than build straight from a one-liner, the agent
  can first run **Expert Expansion** into a complete, **editable** UCC spec - inputs,
  account/authentication (incl. encrypted secrets), proxy/logging, sourcetypes, checkpoints,
  CIM model - shown in a review card. Edit anything (`+ input`, `+ credential field`, change
  auth type, set sourcetype/CIM), then click **Build**. This stops the agent shipping a thin
  one-input add-on with no auth or CIM.
- **Live tool trace.** Every tool the agent runs appears inline as `🔧 <tool><path>` (e.g.
  `🔧 write_file package/bin/my_input.py`). The `build_and_inspect` step renders the full
  build -> inspect -> fix loop.
- **Iteration limit.** The agent stops after a configurable number of planner/executor
  turns. Open **Settings** in the chat to set **Max agent iterations** - **1 to 100, default
  30** in the native app. (Lower caps your LLM spend; a no-progress breaker also stops
  repeated failing actions early.)
- **Continue past the cap.** If it hits the limit mid-task you'll see
  *"Reached the step limit (N) before finishing"* and a **▶ Continue (+N iterations)**
  button that resumes from where it stopped - or raise the limit in Settings first.
- **Advisories vs failures.** A build is **clean** when AppInspect reports **no failures and
  no errors**. **Warnings** and **future-failures** (checks that only fail at a *future*
  Splunk release) are surfaced as **advisories** - worth reviewing, but they do **not** block
  packaging or count as a failed build.
- **Tool approvals.** Tools that reach **outside** the build sandbox - the live-Splunk
  grounding tools (`get_live_indexes`, `run_splunk_query`, ...) - ask for approval on first
  use: **Approve** / **Approve for session** / **Deny**. Local file/build tools run
  silently. "Approve for session" remembers the choice for the rest of the session.

### Run History and Stop

Every agent run is persisted (KV `ucc_agent_traces`). The **🕘 History** panel lists past
runs **newest-first** and can **replay** a run's full trace (assistant turns, tool calls,
results) for review or debugging. **Stop** cancels an in-flight run **server-side** - it
kills the runner's process group so the model call stops billing immediately.

---

## 3. The Monaco editor - autocomplete & AI tab-completion

Open any file in the file browser to edit it in Monaco. There are **three distinct assists**
- people often conflate them, so here's exactly what each one is:

### a) `.conf` IntelliSense + Python SDK completion (always on, free, offline)

- **`.conf` files** - stanza and key **autocomplete** sourced from the bundled Splunk
  `.conf.spec` files, triggered as you type `[`, `=`, or space. The editor also **lints**
  for duplicate stanzas/keys and underlines them.
- **Python files** - completion for the Splunk SDK surface. Accepting a member inserts just
  the member: typing `ew.wr` and accepting gives `ew.write_event` (the class-qualified name
  `EventWriter.write_event` is shown in the detail line for context, not inserted). There are
  also UCC snippets (e.g. a `stream_events` helper skeleton). Python is **syntax-checked**
  server-side via `ast.parse` (no code is executed) and errors are underlined.

### b) Live `globalConfig.json` schema validation (always on)

When you edit `globalConfig.json`, Monaco validates it against the UCC schema in real time.
It starts with a bundled subset and then **upgrades to the authoritative schema extracted
from the installed `ucc-gen`** (`GET /api/ucc/schema`), so the editor's idea of "valid" never
drifts from the build engine's. Schema errors (wrong field type, missing required property,
an invalid `table` action, ...) are underlined before you ever build.

### c) Inline AI completion (ghost text, Tab to accept) - opt-in

A Copilot-style completion that suggests the next span of text as **grey ghost text**; press
**Tab** to accept. It works in `.conf`, Python, and JSON.

- **It is OFF by default.** Toggle it on with the editor's **AI completion** switch
  (*"Ghost-text AI completion in the editor (Tab to accept)"*). The choice is remembered in
  `localStorage`.
- It uses your configured **inline-completion model** (set in Configuration → AI Provider,
  separate from the chat model), is debounced while you type, and is fail-soft - if the model
  call errors it simply shows nothing rather than interrupting you.

---

## 4. GitHub - import & export

The **GitHub** panel (top nav, or the Home cards) both **pushes** your generated add-on to a
repo and **clones** an existing UCC add-on from one.

### One-time: connect with the OAuth Device Flow

There is **no client secret and no env var to set** - you authorise with GitHub's Device
Flow using only an OAuth App **Client ID**.

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**. Any name and
   homepage; for the **Authorization callback URL** any valid URL works (Device Flow ignores
   it).
2. On the created app, tick **"Enable Device Flow"** and save. *(Required - without it GitHub
   returns 404 on the device request.)*
3. Copy the **Client ID** (the `Iv1…` / `Ov23…` value - **not** the secret).

In the panel: paste the **Client ID** (**Save & Continue**), click **Connect to GitHub**,
copy the device code it shows (📋 Copy), and approve it in the browser tab GitHub opens. The
Client ID is stored in your browser's `localStorage`
(`splunk_app_builder_github_client_id`).

> **Hosted Client ID.** A deployment can set `GITHUB_CLIENT_ID` in the server env (served at
> `GET /api/github/config`); when set, the panel uses it and hides the field. The device-flow
> Client ID is not a secret, so this is safe.
>
> **Troubleshooting.** *"did not recognise this Client ID"* → wrong Client ID / app doesn't
> exist. *"Device Flow is not enabled"* → step 2 was skipped.

### Export - push your add-on to a repo

1. In the GitHub panel (default **push** mode), pick a **Repository** from the dropdown, or
   click **New Repo** to create one.
2. Click **Push** - the panel writes your project's files to the repo and shows **Push
   Complete!**

> New repositories are initialised asynchronously by GitHub; the push waits for the repo's
> git database to be ready (a retry-with-backoff) so the first commit lands reliably.

### Import - clone an add-on from a repo

Open **Import from GitHub** (or set the panel to import mode): connect, select the
**Repository**, and click **📥 Clone Repository**. Its UCC source is loaded into the builder
so you can extend it with the AI.

### Seed from an add-on installed on this Splunk (native app only)

In the **Import** view, the **"Seed from an add-on installed on this Splunk"** panel lists
UCC add-ons already installed on this instance (those with a `globalConfig.json`). Click
**Seed** to load one add-on's authoring source - its real `globalConfig.json` (surfaced at
the project root even though a built add-on keeps it under
`appserver/static/js/build/`), plus `default/` and `bin/` - straight into the builder.
Vendored libraries, bytecode and instance-local config are excluded; the path is confined to
`etc/apps`.

---

## 5. The authoring & data toolkit

Beyond the chat and editor, the builder helps you understand the data and produce the
surrounding knowledge objects. Each is also exposed as a **Splunk MCP Server tool** any
external agent can call.

- **Test Input (the input emulator).** Run a modular input's collection code the way Splunk
  would - it finds your `collect_events`/`stream_events` (or a `Script` subclass) in
  `package/bin/<input>.py`, stubs the helper + EventWriter, makes **real HTTP calls with no
  install**, and shows the **actual events it would index**. Use it to design
  `props.conf`/`transforms.conf` from real data instead of guessing.
- **Generate dashboards / saved searches.** Deterministic, LLM-free emitters: a structured
  spec becomes exact **Dashboard Studio v2** view XML or a `savedsearches.conf` stanza
  (report or scheduled alert) - the formats models get wrong by hand - written straight into
  the project.
- **Generate tests.** Scaffolds a **pytest-splunk-addon** suite (`pytest.ini`,
  `test_<addon>.py`, sample data, README) that validates sourcetype/field assignment and
  **CIM** compliance. Closes the loop: *Test Input → author props/transforms → generate
  tests* (seed the samples with the real events you captured in the emulator).
- **My Apps.** A server-side (KV) library of saved add-on projects - save, list, resume and
  delete add-ons across sessions and devices.

---

## Quick reference

| I want to... | Do this |
|---|---|
| Build an add-on from a description | **Home → Build with the AI Agent**, type the request, review the spec, **Build** |
| Let the agent run longer | Chat **Settings → Max agent iterations** (1-100), or **▶ Continue** when it stops |
| Turn on AI tab-completion | Editor **AI completion** toggle (off by default); **Tab** accepts ghost text |
| Validate globalConfig as I type | Just edit `globalConfig.json` - schema validation is always on |
| Push to GitHub | **GitHub** panel → pick/`New Repo` → **Push** |
| Pull an add-on from GitHub | **Import from GitHub** → select repo → **📥 Clone Repository** |
| Extend an installed add-on | **Import → Seed from an add-on installed on this Splunk → Seed** |
| See what events an input would emit | **Test Input** with sample field values |
| Replay or stop a past agent run | **🕘 History** (newest first); **Stop** cancels server-side |
