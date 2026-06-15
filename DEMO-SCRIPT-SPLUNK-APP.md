# Demo Script — UCC App Builder *as a native Splunk app* (under 3 minutes)

> Goal: show **two Splunk-AI integrations, both live inside Splunk** — (1) the builder's
> tools called on **Splunk's own MCP Server**, and (2) an in-app agent on the **Splunk
> Agent SDK (`splunklib.ai`)** that authors and ships an **AppInspect-clean** add-on from a
> plain-English request.

Total runtime target: **~2:50**. Everything below is reproducible on the live instance.

---

## 0:00 — The problem (15s, title slide / talking head)

> "Getting a Splunk add-on through **AppInspect** is a slow, expert-only loop. We turned it
> into a conversation that runs **inside Splunk** — exposed on Splunk's MCP Server and
> driven by the Splunk Agent SDK."

## 0:15 — Headline 1: builder tools on the **Splunk MCP Server** (50s, screen capture)

Show that the app's tools are first-class **Splunk MCP** tools (callable by the Splunk AI
Assistant, Claude Desktop, or any MCP client).

1. Show `splunk-app/ucc-app/default/tools.conf` — the 7 `ucc_*` tools (1 line each).
2. In a terminal, call them on Splunk's MCP server (or via the Splunk AI Assistant):
   - `ucc_create_addon {"name":"acme_demo"}` → `appId: ta_acme_demo`
   - `ucc_write_file {"path":"globalConfig.json","content":"…"}` → `ok`
   - `ucc_list_project` → shows the file
   - `ucc_read_file {"path":"globalConfig.json"}` → returns it back
   > "These are running on **Splunk's own MCP Server** — the same registry the AI Assistant
   > uses. State persists across calls, scoped to my user, path-confined to the project."

## 1:05 — Headline 2: the in-app Advisor = the **Splunk Agent SDK** (75s, screen capture)

The money shot. One natural-language request → an agent inside Splunk authors and ships a
clean package.

1. Fire the Advisor (REST, or the app's chat UI):

   ```bash
   curl -sk -H "Authorization: Splunk $SESSION_KEY" \
     -H 'Content-Type: application/json' \
     https://<host>:8089/services/ucc_app_builder/advisor \
     -d '{"prompt":"Build a UCC add-on called contoso_logs with a required api_url text field (URL validator). Author globalConfig.json, then build_and_inspect.","model":"anthropic/claude-sonnet-4.6"}'
   ```

2. Narrate the returned trace (the agent's own tool calls):
   - `create_addon` → `ta_contoso_logs`
   - `write_file globalConfig.json` — the agent authors the core artifact
   - `build_and_inspect` → ucc-gen build + `splunk-appinspect` → **`clean: true`**
   - Result: **`ta_contoso_logs-1.0.0.tar.gz`**, AppInspect-clean, in ~40s.

   > "That agent is the **Splunk Agent SDK — `splunklib.ai`**. Its tools are the same builder
   > operations; its LLM is provider-agnostic, here pointed at OpenRouter. It authored the
   > add-on, built it, ran AppInspect, and confirmed zero failures — all inside Splunk."

## 2:20 — Why it's airtight + one engine (20s)

> "Every file path is confined under the project in KV — the agent can't read the Splunk
> filesystem. And it's **one engine**: the same build loop powers the MCP tools, the Agent
> SDK advisor, and a standalone Monaco IDE — no duplicated code."

## 2:40 — Close (10s)

> "Describe an add-on; get an AppInspect-clean package — on Splunk's MCP Server and the
> Splunk Agent SDK. UCC App Builder."

---

### Recording notes / reproduce

- App installed at `/opt/splunk/etc/apps/ucc_app_builder`; build with
  `splunk-app/deploy/build_agent_app.sh`; register MCP tools with
  `splunk-app/deploy/register_mcp_tools.py`.
- OpenRouter key in `storage/passwords` (realm `ucc_app_builder`, user
  `openrouter_api_key`); build-engine URL in `ucc_app_builder_settings.conf [build_engine]`.
- `$SESSION_KEY` from `POST /services/auth/login` (or use a bearer token). The Advisor body
  is raw JSON; `model` is optional (defaults to `anthropic/claude-sonnet-4.6`).
- Trace evidence + the five SDK-in-Splunk gotchas: `docs/SPLUNK-APP-PLAN.md`.
