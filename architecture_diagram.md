# UCC App Builder — Architecture

> Splunk Agentic Ops Hackathon 2026 — Platform & Developer Experience track.
>
> **Describe a Splunk add-on in plain English; an AI agent authors it, builds it with
> `ucc-gen`, runs `splunk-appinspect`, self-corrects in a loop, and hands back an
> AppInspect-clean `.tar.gz` — running _inside Splunk_ on the Splunk Agent SDK.**

The same engine ships **two faces** from one codebase (no duplication):

1. **Native Splunk app** (`splunk-app/`, app id `ucc_app_builder`) — the headline. Its
   builder tools are exposed as **Splunk MCP Server tools** (`tools.conf`), and an in-app
   **Agent** runs on the **Splunk Agent SDK (`splunklib.ai`)**. Proven end-to-end live on
   Splunk Enterprise 10.4.
2. **Standalone web app** (`src/` + `server/`) — a React/Vite Monaco IDE + chat over the
   identical build engine, for local/offline authoring.

---

## 1. Native Splunk app — the two headline integrations

### A. Builder tools exposed as **Splunk MCP Server** tools

The app declares 7 builder tools in `default/tools.conf`; each maps to a persistent REST
handler (`bin/builder_tools.py`). They are registered into the **Splunk MCP Server** (KV
collections `mcp_tools` + `mcp_tools_enabled`, API-execution → the app's REST endpoints),
so **any MCP client — the Splunk AI Assistant, Claude Desktop, another agent — can build a
Splunk add-on by calling tools on Splunk's own MCP server.**

```
  MCP client (Splunk AI Assistant / Claude / agent)
        │  tools/call ucc_create_addon, ucc_write_file, ucc_build_and_inspect …
        ▼
  Splunk MCP Server (Splunkbase 7931)  ──API-execution──▶  /services/ucc_app_builder/<tool>
        │                                                         │  bin/builder_tools.py
        │                                                         ▼
        │                                          KV-backed, path-confined project (per user)
        └─ build/package tools proxy ───────────────────▶  Node build engine (ucc-gen + AppInspect)
```

`ucc_ping · ucc_create_addon · ucc_write_file · ucc_read_file · ucc_list_project ·
ucc_build_and_inspect · ucc_package`. *Proven live:* `create → write → list → read` with
state persisting across calls; `build_and_inspect → AppInspect-clean tarball`.

### B. In-app **App Builder Advisor** = the Splunk Agent SDK (`splunklib.ai`)

`POST /services/ucc_app_builder/advisor {"prompt": "...", "model": "..."}` runs an agent
built on **`splunklib.ai`** (the Splunk Agent SDK, shipped in splunk-sdk 3.0). The agent's
LLM is provider-agnostic; we point an OpenAI-compatible client at **OpenRouter** (reuses
existing credit — no SAIA entitlement / hosted-model dependency required). The agent's
**local tools are the same builder operations**, discovered by the SDK as a local MCP tool
server (`bin/tools.py` → `registry.run()`).

```
  POST /services/ucc_app_builder/advisor
        │
        ▼
  bin/builder_advisor.py  (thin REST handler — reads the OpenRouter key from
        │                   storage/passwords + config via splunk.rest)
        │  spawns a PRISTINE interpreter  (PYTHONPATH = app lib only)  ─── see note ▼
        ▼
  bin/advisor_runner.py  ──▶  splunklib.ai Agent
        │                        ├─ model: OpenAIModel(base_url = OpenRouter)
        │                        ├─ tools: ToolAllowlist(tags=["ucc_builder"])
        │                        └─ limits: AgentLimits(max_steps)
        │                              │  SDK spawns the local MCP tool server:
        │                              ▼
        │                       bin/tools.py → builder_agent_tools (create_addon,
        │                       write_file, read_file, list_project, build_and_inspect)
        │                              │            (same KV-backed, path-confined store)
        ▼                              ▼
  {ok, answer, trace}          build_and_inspect ──▶ Node build engine (ucc-gen + AppInspect)
                                                          └─▶ AppInspect-CLEAN .tar.gz
```

**Why a subprocess (the key architectural decision):** splunkd runs persistent REST
handlers in a **shared interpreter** already populated with dozens of other apps'
libraries (older `splunklib`, `pydantic` v1, mismatched `typing_extensions`, …). Importing
the vendored agent stack in-process collides non-deterministically. So the handler stays a
thin shell and spawns `advisor_runner.py` as a fresh `/opt/splunk/bin/python3` process with
`PYTHONPATH` = our lib only — a clean interpreter (exactly how the SDK itself spawns
`tools.py`). Deterministic, zero collisions.

### Security model (airtight by construction)

All file tools go through `builder_common.to_safe_project_path`, which **confines every
path under `<appId>/`** and rejects absolute paths, `..`/`.` segments, backslashes and NUL.
The project lives in a **KV collection keyed per authenticated user** — the agent can read
and write *only its own add-on project*, never the Splunk filesystem or other apps.

---

## 2. The keystone loop — generate → AppInspect → fix → repeat

Both faces share one engine: `server/services/agentLoop.ts` (`runAgentLoop`). The native
app's `build_and_inspect` tool proxies to it over `POST /api/mcp/build_engine`; the
standalone UI calls it directly.

1. **Generate** — write the source VFS to a temp dir; `ucc-gen build/package` → `.tar.gz`.
2. **Inspect** — `splunk-appinspect inspect` → structured checks. The **clean gate is
   failures-only** (AppInspect *warnings* are advisory and do not block packaging).
3. **Fix** — **deterministic rules first** (free, instant; e.g. auto-generate the required
   `package/app.manifest` ucc-gen doesn't create; `checkForUpdates=false` in *globalConfig*,
   not the regenerated `app.conf`), then an **LLM fixer** (Claude via OpenRouter) for the
   rest, editing *source* (ucc-gen regenerates `default/*.conf`).
4. **Repeat** with the corrected source until clean or `maxIterations`.

Every step emits a trace event. *Proven live:* "build an add-on called contoso_logs with an
api_url field" → authored `globalConfig.json` → `build_and_inspect` → **AppInspect-clean
`ta_contoso_logs-1.0.0.tar.gz` in ~40s.**

---

## 3. Second face — standalone web app (same engine)

A React + Vite **Monaco IDE** + chat panel over an Express server. The chat drives a
planner/executor tool-calling agent (`server/services/agentRunner.ts`, one loop shared by
the SSE route and the eval bench); it also **consumes** the Splunk MCP Server to ground
suggestions in live indexes/sourcetypes, and **exposes** the same builder tools over an
HTTP/stdio MCP server. This is the rich human IDE; the native Splunk app is the in-platform,
MCP-and-Agent-SDK surface. One `server/mcp/core.ts` engine backs both.

```
  Browser (Monaco IDE + chat) ──SSE──▶ Express (server/) ──▶ runAgentLoop (ucc-gen + AppInspect + fixers)
                                              │                        ▲
                                              ├─ consume Splunk MCP ───┘ (live indexes/sourcetypes)
                                              └─ expose builder tools as MCP (stdio + HTTP)
```

---

## Toolchain / models

- `ucc-gen` 6.5, `splunk-appinspect` 4.2.1, Node 20, Splunk Enterprise 10.4 (CPython 3.13).
- Splunk Agent SDK = `splunklib.ai` (splunk-sdk 3.0, **vendored** — not on public PyPI);
  compiled agent deps installed as cp313 manylinux wheels (`splunk-app/deploy/build_agent_app.sh`).
- LLM: Claude (default `anthropic/claude-sonnet-4.6`) via **OpenRouter**, provider-agnostic.
  The agent's *reasoning* is the LLM; the **Splunk MCP Server, the Agent SDK, ucc-gen and
  AppInspect are the tools**.
