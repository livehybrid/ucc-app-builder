# Plan: UCC App Builder → Splunk-packaged app exposing MCP tools

> Goal: make the builder's strongest hackathon angle a tie-in to **Splunk's own AI**.
> Register the build capabilities as **MCP tools** on the Splunk MCP Server so the
> **Splunk AI Assistant** can build a UCC add-on by calling them, with a Monaco UI
> in the Splunk app for humans to see/edit what the Assistant produces.
> Branch: `feat/splunk-app-mcp-tools` (off `agentic-appinspect-loop`).

## LOCKED architecture (env-confirmed 2026-06-14) — native Splunk 10.4 app + splunklib.ai

Environment facts (verified on .222): **Splunk 10.4.0**, bundled **Python 3.13.11**
(so `splunklib.ai` agent invocation runs natively), REST install works with admin
creds (no OS sudo needed), and the MCP registration mechanism is **native
`tools.conf`** (`[restmap:<tool>]` stanzas → a REST `endpoint_name` → a `bin/`
Python handler). The Splunk AI Assistant calls those REST endpoints.

**Final design (Option B, native):**
- A **UCC Splunk app** (`splunk-app/`, templated from the Data Dictionary) whose
  build tools are **native REST handlers** declared in `default/tools.conf` —
  `ucc_create_addon`, `ucc_write_file`, `ucc_read_file`, `ucc_list_project`,
  `ucc_build_and_inspect`, `ucc_package`, `ucc_ping`. The **Splunk AI Assistant**
  drives a build by calling these MCP tools.
- An **in-app advisor** (`bin/` REST handler) that runs an agent via **`splunklib.ai`
  with `ai_provider=splunk_hosted`** (Splunk hosted models, SCS token via
  `/services/authorization/scs_tokens`) using the SAME tools — the headline
  "Best Use of Splunk Hosted Models" hook (TrackMe pattern).
- **File tools**: native Python, confined to a per-session project (KV/temp),
  reusing the same path-safety rules as `server/mcp/core.ts` (no traversal).
- **`ucc_build_and_inspect`**: proxies to the existing **Node sidecar** (ucc-gen +
  AppInspect) — the one piece kept as a service, since ucc-gen/appinspect are build
  tools not present in the app runtime. (Sidecar URL is an app config setting.)
- **Monaco UI**: a Splunk React page (`@splunk/react-ui` + Monaco) showing/editing
  the same project files the tools mutate.
- **Standalone fallback preserved**: the Node engine + Vite UI still run as before;
  `server/mcp/core.ts` is the shared logic. One repo, no duplication.

Install/test: build with `ucc-gen` on the dev box → package → install via REST
(`/services/apps/local`) on .222 → register the MCP tools → drive via the Splunk
AI Assistant or direct REST.

## Earlier note — Option A (superseded by the native tools.conf design above)
Option A (API-execution MCP tools → Node sidecar) was the fallback when py3.13 /
native registration were unconfirmed. With Splunk 10.4 + py3.13 + native tools.conf
confirmed, we go native (Option B). The `server/routes/mcp.ts` HTTP seam still
serves the **standalone** mode and as the sidecar the build tool proxies to.

## (historical) Architecture decision: Option A — API-execution MCP tools → Node sidecar

The build engine (`ucc-gen`, `splunk-appinspect`, the planner/executor self-correct
loop) stays in the proven Node service. The Splunk MCP Server supports
**API-execution tools** (this is how the `saia_*` tools call an external HTTP API),
so we register tools whose `_meta.execution` points at the builder's HTTP endpoints.
The Splunk app is then a **thin layer**: the tool signatures + a Monaco page.

Rejected: porting the engine to Splunk's embedded Python (Option B) — `ucc-gen`/
`appinspect` aren't verifiably installed/runnable on the instance (REST-only access),
and it would discard the hardest-won, working code. Not feasible well in the time.

## MCP tool surface (mirrors the Data Dictionary signatures model)

API-execution tools → builder sidecar `POST /api/mcp/<tool>` (also `/api/mcp/dispatch`):

| Tool | Purpose |
|---|---|
| `ucc_ping` | health check (call first when debugging) |
| `ucc_create_addon` | start/reset a project (appId = TA_<name>) |
| `ucc_write_file` | author/overwrite globalConfig.json, package/bin/*.py, … (Monaco shows the same files) |
| `ucc_read_file` / `ucc_list_project` | inspect what the Assistant/human produced |
| `ucc_build_and_inspect` | the self-correct loop: ucc-gen → AppInspect → auto-fix → repeat to CLEAN |
| `ucc_package` | build to CLEAN, return installable .tar.gz |

Assistant-driven build: `ucc_create_addon` → `ucc_write_file globalConfig.json` →
`ucc_build_and_inspect` (patch + repeat on findings) → `ucc_package`. The human
watches/edits in the Monaco page. Because `saia_*` and `ucc_*` share the MCP server,
the Assistant can also `saia_generate_spl` to draft SPL the add-on ships.

## ✅ PROVEN LIVE on .222 (2026-06-14) — the headline works

The native Splunk app is **installed and its MCP tools work end-to-end through the
Splunk MCP Server**:
- App installed via `sudo -u splunk /bin/cp` into `/opt/splunk/etc/apps` + REST
  restart; loaded, enabled, REST handlers live.
- All 7 tools registered into the MCP server (`mcp_tools` + `mcp_tools_enabled`,
  API-execution → our REST endpoints) via `deploy/register_mcp_tools.py`.
- Verified by direct MCP `tools/call`: `ucc_create_addon{name}` → `ucc_write_file
  globalConfig.json` → `ucc_list_project` (shows the file) → `ucc_read_file` (reads
  it back). **State persists across calls** (KV scoped to the authenticated user).

So: *the Splunk AI Assistant / any MCP client can build a UCC add-on by calling our
tools, inside Splunk.* This is the "Best Use of Splunk MCP Server" story, live.

Key mechanics learned (from the MCP server source): app tools register in two KV
collections (`mcp_tools` defn + `mcp_tools_enabled`); execution `type:"api"` with
`{method, endpoint, headers, params, body}`; `$arg$` placeholders in `body` are
substituted with the call args (exact `"$k$"` → raw typed value; unfilled optional
placeholders dropped); bodies are form-encoded unless a JSON Content-Type header is
set (our handler now parses both, plus query params).

Remaining: `ucc_build_and_inspect`/`ucc_package` need the Node build engine reachable
from .222 (set `build_engine` url); the `splunklib.ai` advisor (note: splunklib.ai is
NOT in the bundled splunk-sdk here — needs sourcing); the Monaco UI page.

## The Splunk Agent SDK path (splunklib.ai) — achievable on .222 via OpenRouter

Clarification that unblocks the "go big" headline on on-prem .222:
- **SAIA ≠ the Splunk Agent SDK.** SAIA (Splunk AI Assistant) is the SCS-backed chat
  product (broken on .222, no SCS). The **Splunk Agent SDK is `splunklib.ai`** — a
  provider-agnostic agent library. It does NOT need SAIA or hosted models.
- **`splunk-sdk>=3.0.0` bundles `splunklib.ai`** (our earlier 2.1.0 didn't); it
  requires **Python 3.13** (present on Splunk 10.4). Deps: langchain>=1.2.15,
  langchain-openai, langgraph, pydantic, uuid-utils.
- **OpenRouter works**: `splunklib.ai.model.OpenAIModel(model, base_url, api_key)`
  passes base_url straight to the OpenAI client → set `base_url=https://openrouter.ai/api/v1`
  + the OpenRouter key. Reuses the existing OpenRouter credit; no Anthropic billing.
- **How TrackMe triggers agents** (the pattern we mirror): a custom UI → a custom
  **REST handler** → an async **splunklib.ai `Agent` job** (KV-backed) + scheduled
  custom commands. NOT via MCP, NOT via SAIA. Tools are registered with
  `@registry.tool(tags=[...])` (`from splunklib.ai.registry import ToolRegistry`),
  discovered from `bin/tools.py`, and exposed via
  `ToolSettings(local=LocalToolSettings(allowlist=ToolAllowlist(tags=[...])))`.
  (The SDK can ALSO load remote tools from the Splunk MCP Server.)

**Built (scaffold, needs deploy+test on .222 — py3.13 only, untestable on the dev box):**
- `bin/builder_agent_tools.py` — `ToolRegistry` + `@registry.tool(tags=["ucc_builder"])`
  (create_addon/write_file/read_file/list_project/build_and_inspect), reusing the
  KV-backed, path-confined builder_common.
- `bin/tools.py` — SDK local-tool discovery entry (imports the registry).
- `bin/builder_advisor.py` — REST handler at `/ucc_app_builder/advisor`: builds
  `OpenAIModel(base_url=OpenRouter)`, runs `Agent(... tool_settings=local allowlist
  tags=ucc_builder ...).invoke([HumanMessage(prompt)])` via asyncio.
- `lib/requirements.txt` → `splunk-sdk>=3.0.0` + langchain/langgraph/pydantic.
Next: ucc-gen rebuild (pulls the large agent deps) → install on .222 → store the
OpenRouter key in storage/passwords → POST a prompt to /ucc_app_builder/advisor → iterate.

## ✅ Advisor SDK stack VALIDATED on Splunk py3.13 (2026-06-14)

The `splunklib.ai` advisor is validated locally using **Splunk's own python**
(`/opt/splunk/bin/python3` = 3.13.11) — no deploy needed for API validation:
`SPLUNK_HOME=/opt/splunk LD_LIBRARY_PATH=/opt/splunk/lib PYTHONPATH=<built>/lib:<built>/bin /opt/splunk/bin/python3`
constructs `Agent(service, model=OpenAIModel(base_url=OpenRouter), tool_settings=
ToolSettings(local=LocalToolSettings(allowlist=ToolAllowlist(tags=["ucc_builder"])),
remote=None), limits=AgentLimits(max_steps=16))`. `ssl` works (OpenSSL 3.5.5) so the
OpenRouter HTTPS call is fine. Handler corrected to this exact API.

Two packaging facts solved:
1. **splunk-sdk 3.0.0 (splunklib.ai) is NOT on public PyPI** (max 2.1.1) → `splunklib`
   is **vendored** under `ucc-app/lib/splunklib` (Apache-2.0, from TrackMe's 3.0.0 wheel).
2. **Compiled deps must be cp313 / linux-x86_64** (Splunk's runtime), but ucc-gen
   installs with the build host's py3.10. `deploy/build_agent_app.sh` runs ucc-gen
   then re-installs the agent deps as **cp313 manylinux wheels** into the output lib
   (`pip --python-version 3.13 --only-binary=:all: --platform manylinux2014_x86_64`).

Remaining for a full run (next): build via `build_agent_app.sh` → `sudo cp` to
`/opt/splunk/etc/apps` → restart → store the OpenRouter key in storage/passwords
(realm `ucc_app_builder`, user `openrouter_api_key`) → POST a prompt to
`/ucc_app_builder/advisor` → the agent authors a globalConfig + runs the build loop.
The agent's `async with` does network (splunk username/privilege check + the LLM +
tool calls), so the end-to-end run is validated in-Splunk.

## ✅ Advisor PROVEN LIVE end-to-end on .222 (2026-06-14)

The in-app **App Builder Advisor** ran fully on the live Splunk 10.4 instance:
agent (`splunklib.ai`) → **OpenRouter** (`anthropic/claude-sonnet-4.6`) → spawned
local MCP tool server (`bin/tools.py`) → `create_addon` + `write_file globalConfig.json`,
with state **persisting across separate invocations** (a second call's fresh
subprocess ran `list_project`/`read_file` and saw the project the first call wrote).
Verified via `POST https://192.168.0.222:8089/services/ucc_app_builder/advisor`
(admin session, raw-JSON body `{"prompt":...,"model":...}`).

**Full build loop proven (2026-06-14):** "Build an add-on called contoso_logs with
an api_url field" → agent authored globalConfig.json → `build_and_inspect` → the
live Node build engine (ucc-gen + AppInspect at 127.0.0.1:3011) → **AppInspect-CLEAN**
(0 failures) → `ta_contoso_logs-1.0.0.tar.gz`, in ~40s. So the headline demo —
natural language → agentic authoring → real, AppInspect-clean Splunk package — runs
end-to-end inside Splunk on OpenRouter.

**Architecture lock — the agent runs in a clean subprocess.** splunkd runs persistent
REST handlers in a SHARED interpreter polluted with dozens of other apps' libraries.
Purging `sys.modules` per-package was whack-a-mole (splunklib → pydantic →
typing_extensions → …, non-deterministic per restart). The robust fix: `builder_advisor.py`
stays a thin shell (reads secret/conf via splunk.rest, safe) and spawns
`bin/advisor_runner.py` as a fresh `/opt/splunk/bin/python3` subprocess with
`PYTHONPATH` = our lib only — a pristine interpreter (exactly how the SDK already
spawns `bin/tools.py`), exchanging JSON over stdin/stdout. Zero collisions.

Two correctness bugs fixed along the way:
- **`KVProjectStore.reset()` didn't URL-encode the `_key`** (which contains `/`), so the
  DELETE 404'd and stale files from prior projects accumulated; the build then received
  nested garbage (`<appId>/<otherAppId>/…`) and never went clean. Encoding the key makes
  `create_addon` truly reset the project.
- **`build_and_inspect` clean-gate**: AppInspect WARNINGS are advisory and don't block
  packaging, so the tool now defaults to **failures-only** (`include_warnings=False`) and
  the system prompt tells the agent to STOP on `clean:true` and never chase warnings.

The earlier in-handler fixes that are now encapsulated in `advisor_runner.py`:

1. **`bin/tools.py` must RUN an MCP stdio server, not just import the registry.**
   The SDK *spawns* `bin/tools.py` as an MCP stdio subprocess; it must end with
   `if __name__ == "__main__": registry.run()` (mirrors TrackMe). Symptom otherwise:
   `mcp.shared.exceptions.McpError: Connection closed` at `session.initialize()`.
2. **The SDK subprocess strips the environment** (forwards only `LD_LIBRARY_PATH`).
   `bin/tools.py` must re-set `SPLUNK_HOME` (from its own path) **and** `SPLUNK_DB`
   (`$SPLUNK_HOME/var/lib/splunk`) — `splunk.rest` reads `SPLUNK_DB` at import or it
   raises `KeyError: 'SPLUNK_DB'`.
3. **splunklib namespace collision.** Many other apps ship splunklib 2.x (no `.ai`);
   splunkd's shared handler interpreter may have one cached in `sys.modules` first, so
   `import splunklib.ai` fails with `No module named 'splunklib.ai'`. Fix in
   `builder_advisor.py`: force our `lib/` to `sys.path[0]` **and purge** any pre-cached
   `splunklib*` from `sys.modules` so the vendored 3.0 re-imports.
4. **CA bundle for outbound TLS.** splunkd sets `SSL_CERT_FILE` to a path that doesn't
   exist in the handler process, so httpx (langchain-openai) dies with
   `FileNotFoundError` opening the OpenRouter connection. Fix: point `SSL_CERT_FILE`/
   `REQUESTS_CA_BUNDLE` at the **vendored certifi** bundle before building the model.
5. **Double `Splunk ` token prefix → HTTP 401.** The handler builds the service with
   `token="Splunk <sk>"`; `ctx.service.token` carries that prefix into the tool, and
   `splunk.rest.simpleRequest(sessionKey=...)` adds its own `Splunk ` prefix. The KV
   tools must **strip** the leading `Splunk ` before using it as a `sessionKey`.

## Progress

- [x] **Phase 0.1 — sidecar HTTP MCP seam (DONE).** Shared `server/mcp/core.ts`
  (`BuilderSession` VFS + `BUILDER_TOOLS` + `handleBuilderTool`); `server/routes/mcp.ts`
  exposes `GET /api/mcp/ping|tools`, `POST /api/mcp/dispatch`, `POST /api/mcp/:tool`.
  Unit-tested (`core.test.ts`, 8) + live-verified (create→write→list→read round-trip).
- [ ] **Phase 0.2 — Splunk app scaffold.** New `splunk-app/` UCC app from the DD
  template + `splunk-react-app` skill: `globalConfig.json`, `ucc-app/bin/` REST
  handlers (proxy to the sidecar), `default/restmap.conf`+`web.conf`.
- [ ] **Phase 0.3 — tool signatures.** `appserver/static/tool_input_payload_signatures.json`
  with the `ucc_*` tools as **API-execution** (clone `saia_*` shape; no SPL fields;
  pre-quoted string defaults; `external_app_id`). Register into the MCP server's
  `mcp_tools` KV via the full-doc REST replace (see DD `deploy/REDEPLOY.md`).
- [ ] **Phase 0.4 — Monaco page.** Port `src/components/FileBrowser.tsx` into
  `src/main/webapp/pages/builder/`; reads/writes via a `bin/` handler that proxies
  `/api/mcp/files`+`/file`.
- [ ] **Phase 0.5 — demo.** Drive `ucc_build_and_inspect` end-to-end via the
  Splunk AI Assistant (or direct `tools/call`), show the file in Monaco, end CLEAN.

## Security model (must stay airtight — judged)

The AI agent / Splunk AI Assistant must **never** read or write anything on the host
outside the add-on project. Guarantees:

1. **Reads/lists hit only the in-memory VFS.** `ucc_read_file` / `ucc_list_project`
   operate on the session's `VirtualFileSystem` (a Map), never the real filesystem —
   so there is no way to read Splunk's files through these tools, by construction.
2. **Path confinement at the boundary.** `toSafeProjectPath()` (core.ts) rejects
   absolute paths, any `..`/`.`/empty segment, backslashes, and NUL bytes; every
   write/read is confined under `<appId>/`. `ucc_write_file`/`ucc_read_file` return
   a clean error on violation (unit-tested with traversal payloads).
3. **Disk writes confined to a temp build dir (defense in depth).** The only disk
   interaction is the build loop materialising the VFS into `os.tmpdir()/ucc-app-builder/<id>`.
   `fileHandler.writeFiles` now throws if any path resolves outside that base dir.
4. **No host command surface.** The tools expose only author/build/package — no
   shell, no arbitrary path, no network beyond the build's own pip/ucc-gen.

When this is wired as a Splunk app, the `bin/` REST handler is a thin proxy to the
sidecar and performs no filesystem access of its own.

## Dual-mode: one engine, two deployments (no code duplication)

`server/mcp/core.ts` is the single, transport-agnostic source of the tool logic.
Both deployments share it:
- **Standalone** (today): Vite UI + Node/Express backend; tools over the in-app
  chat, the stdio MCP server, and `POST /api/mcp/*`.
- **Splunk app**: a UCC-packaged app whose `bin/` REST handler + MCP tool
  signatures proxy to the **same** Node backend (sidecar), with a Monaco page.
  Nothing in the engine is reimplemented; the Splunk app is presentation +
  registration only.
This keeps a single codebase that can be demoed standalone AND installed into Splunk.

## Risks + defaults

1. **MCP→sidecar egress/auth** (API-execution to a LAN sidecar, vs SCS for `saia_*`):
   spike `ucc_ping` registration first. Fallback: demo via the existing stdio MCP
   server (`server/mcp/server.ts`) and keep the signatures file as the registered-
   but-pending Splunk artifact.
2. **ucc-gen/appinspect on the instance**: not depended on — the sidecar owns the build.
3. **Hosted Assistant tool discovery**: make tools available (the prize substance);
   demo via direct `tools/call` like DD does.
4. **Registration gotchas**: API tools carry no SPL fields; string args are
   JSON-quoted (pre-quote optional defaults); register via full-doc replace,
   preserving `external_app_id`.
5. **SAIA 400 on the lab instance**: don't gate the demo on it; present it as the
   ready integration; use the app's own Claude agent for SPL drafting if needed.
6. **Time (24h)**: sequence strictly — seam (done) → signatures+ping round-trip →
   build_and_inspect end-to-end → Monaco page last.

## ⚠️ Instance reality check (.222, 2026-06-14) — affects the headline

`.222` is **on-prem Splunk Enterprise 10.4**, not Splunk Cloud:
- `/services/authorization/scs_tokens` → **404**. No SCS tenant → **no Splunk hosted
  models** here. The `splunklib.ai` + `ai_provider=splunk_hosted` headline is **not
  demonstrable on this instance** (it needs Splunk Cloud / SCS).
- Installed apps include `Splunk_MCP_Server`, `Splunk_AI_Assistant_Cloud`,
  `Splunk_ML_Toolkit`, `splunk-ai-canvas`. The `saia_*` MCP tools 400 (AI Assistant
  Cloud's model backend looks unprovisioned on-prem) — so an "AI Assistant drives
  our tools with a live model" demo also isn't guaranteed here.

**What IS real & demonstrable on .222:** the **Splunk MCP Server** (register our
build tools via tools.conf → callable by any MCP client, like the DD tools) and the
**Developer Tools** loop (ucc-gen + AppInspect). `splunklib.ai` (the Splunk Agent
SDK) still runs here, but on a **configured external provider** (Anthropic key), not
hosted models.

**Decision needed:** target a **Splunk Cloud** instance for the hosted-models
headline, OR lead the Builder on .222 with **MCP Server + Developer Tools + the
Splunk Agent SDK (`splunklib.ai`) on a configured provider**. The advisor is built
provider-agnostic either way (splunk_hosted when available, else anthropic/openai).

## Reference: the Splunk Agent SDK (`splunklib.ai`) — from TrackMe

TrackMe (a mature Splunkbase app) is a production reference for the **modern Splunk
Agent SDK**, which is the not-well-documented "Splunk AI SDK":

- **`splunklib.ai`** — the official Splunk Python SDK's agent module. `ucc-gen`
  installs it into the app's `lib/splunklib/ai/` at build time (no vendoring).
  Surface seen in TrackMe: `agent.py`, `base_agent.py`, `middleware.py`
  (`ModelRequest`, `before_model` hooks), `engines/langchain.py`
  (`_create_langchain_model`), `model.py`, `conversation_store.py`, `hooks.py`,
  `limits.py`. Under the hood it wraps **langgraph/langchain** chat models.
  **Agent invocation requires Python 3.13** (TrackMe lazy-imports so py3.9 can still
  poll job status); agent jobs run async, persisted to a KV collection with a watchdog.
- **`splunk_hosted` provider** — set `ai_provider="splunk_hosted"` and the SDK
  auto-discovers the base URL from SCS tenant info, fetches a bearer token via
  `/services/authorization/scs_tokens`, lists models ("slim models"), and runs the
  agent against **Splunk-hosted models** — no external API key. This is the direct
  hook for the hackathon's **Best Use of Splunk Hosted Models** bonus.
- **Advisor/Concierge consent pattern** — TrackMe's LLM ends a turn with a fenced
  ```json `advisor_invocation`/`concierge_invocation` "action contract"; the chat UI
  renders it as a **clickable consent card**; the human approves; the action runs
  against the REST API (read-mode by default, write only on explicit authorisation).
  Same propose→consent→apply boundary we already use in the Data Dictionary.

**Implication for this app:** a Splunk-packaged builder could run its agent via
`splunklib.ai` with `ai_provider=splunk_hosted`, making the AI itself a *Splunk*
capability (Hosted Models) rather than external Claude — a much stronger theme/bonus
fit. Cost: needs py3.13 on the instance + langchain/langgraph deps, and is heavier
than the Option-A sidecar. Recommended as a **Phase 2 stretch** — the Option-A MCP
seam still ships first; the `splunklib.ai` advisor is the high-value upgrade if time
allows. Blueprint: context/splunk-app-ai-agent-pattern.md.

## Notes
- The existing stdio MCP server (`server/mcp/server.ts`) keeps its component-based
  tools and the `mcp:smoke` test; `core.ts` is the new canonical path for the
  Splunk/HTTP surface. Consolidating stdio onto `core.ts` is a later cleanup.
