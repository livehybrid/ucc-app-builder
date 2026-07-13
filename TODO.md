# UCC App Builder — Improvement Roadmap

A "pick up later" backlog of recommended improvements to lift this from useful to top-class. Each item includes enough context to resume cold without re-investigating the codebase. Ordered by impact/effort tradeoff. Quick wins from the previous batch (test 2 false positive fix, .gitignore for vite.config.js) are already shipped.

> **Repo orientation.** Frontend lives in [src/](src/) (Vite + React + TS, Monaco via `@monaco-editor/react`). The Express/SSE backend that drives the AI agent loop lives in [server/](server/), entry [server/index.ts](server/index.ts), main route [server/routes/ai.ts](server/routes/ai.ts). Virtual file system in [src/lib/vfs.ts](src/lib/vfs.ts) is the source of truth for in-app files; nothing is on disk until ZIP/export. E2E tests in [tests/e2e/](tests/e2e/) — Playwright, both servers boot via `playwright.config.ts` `webServer` array. Vite's `server.proxy` forwards `/api/*` to `localhost:3001` (see [vite.config.ts](vite.config.ts)).

---

## Strategic priorities

These are the bets that move the product from "useful" to "10x better than VS Code + Copilot for Splunk UCC apps."

### 1. Visual editors for globalConfig.json

**Why:** The whole point of UCC is the schema-driven config — yet today users edit JSON by hand or via AI. Form-based editors are the single biggest moat against generic AI IDEs.

**Scope (pick one to start, prove the pattern):**
- **Modular Inputs editor** (best first target — most common use case)
  - Form for `pages.inputs.services[]`: name, title, description
  - Add/edit/delete entity fields with type picker (text/textarea/checkbox/singleSelect/multipleSelect/oauth/interval/index)
  - Validators per field (string length, regex, number range, url/email/ipv4/date)
  - Live preview of generated JSON in collapsible panel
- **Accounts/Credentials editor** — `pages.configuration.tabs.accounts`
- **Alert Actions editor** — `alerts[]` with parameter schema
- **Custom Commands editor** — needs corresponding `commands.conf`

**Implementation notes:**
- The UCC schema is already loaded in Monaco at [src/components/FileBrowser.tsx](src/components/FileBrowser.tsx#L199-L206) — use the same `uccSchema` import for form validation
- Add a "Visual / JSON" toggle in the file editor toolbar; default to Visual when the file is `globalConfig.json` and parses cleanly
- JSON stays as the source of truth — visual editor reads/writes via the VFS just like Monaco
- Component scaffold could live in `src/components/visual/` (new directory); `ModularInputsEditor.tsx`, `AccountsEditor.tsx`, etc.
- Existing form patterns in [src/components/Wizard.tsx](src/components/Wizard.tsx) are a good reference for input components and validation UX

**Risks:** Schema drift — UCC adds new field types over time. Pull the canonical schema from `addonfactory-ucc-generator` at build time rather than hardcoding.

**Effort:** ~2 weeks for one editor (Modular Inputs); ~1 week each for additional editors once the pattern is set.

#### 1a. Advanced wizard settings — UCC meta properties

**Why:** [navColor](https://splunk.github.io/addonfactory-ucc-generator/metadata/#metadata-properties) is now wired through `meta.navColor` in [src/types/globalConfig.ts](src/types/globalConfig.ts) (one quick win down). The same `meta` block on `globalConfig.json` exposes several other knobs that today are hardcoded or absent — surfacing them in an "Advanced settings" wizard step would unlock real customisation without forcing users into hand-edited JSON.

**Concrete UCC `meta` properties worth adding to the wizard:**
- `navColor` ✅ already wired (uses Branding step's color picker; consider exposing it again under Advanced for clarity)
- `apiVersion` — pin a specific UCC framework version (default omits it; user may want to lock to 2.0.0 etc.)
- `searchViewDefault` — landing search view name; today we hardcode `"search"` in [src/lib/generator.ts](src/lib/generator.ts) `generateNavXml`
- `isVisible` — hide the app from the Splunk Apps menu (useful for utility add-ons that ship with TAs)
- `defaultView` — default landing view when the app is opened (search vs dashboards vs custom)
- `description` — long-form app description (currently lives on `app.manifest`; UCC also reads it from `meta.description`)
- `restRoot` — override the REST endpoint root (today hardcoded to `appId`); rarely needed but blocks unusual deployments

**Other UCC schema sections worth wizardizing:**
- `pages.configuration.tabs[]` — beyond Account/Logging/Proxy, allow custom config tabs (already supported in `globalConfigType` but no wizard UI)
- `pages.dashboard` — UCC dashboard widgets; today not generated at all
- `alerts[]` — alert action editor (covered in #1 above but worth flagging that `meta`-level alert defaults exist too)
- `options.restHandlers[]` — for users who want custom REST handlers beyond the auto-generated ones

**Implementation notes:**
- Add an optional **Advanced** step to the wizard between Branding and Components (or as a collapsible panel within Review)
- Plumb new fields through [src/types/app.ts](src/types/app.ts) `WizardState.metadata` and on through [src/types/globalConfig.ts](src/types/globalConfig.ts) `createGlobalConfig` (the navColor pattern is the template)
- Validate values against [src/lib/uccSchema.json](src/lib/uccSchema.json) — Ajv is now a dep (used server-side); the same schema works client-side too
- Don't expose every `meta` field — pick the high-value ones above; the rest can stay "JSON-only" power-user settings

**Effort:** ~3 days for wizard step + types + 4-5 fields. Add fields incrementally afterward.

---

### 2. AI agent UX upgrades

The AI is the killer feature but the loop is opaque, slow, and uninterruptible. Five concrete improvements, all using infrastructure that already exists:

#### 2a. Diff-review mode for AI writes (default)

**Why:** Today the AI writes files directly when auto-accept is on. Users have no chance to review before changes land. This is the #1 source of "AI broke my project" friction.

**How:**
- [src/components/AIChatPanel.tsx](src/components/AIChatPanel.tsx#L2) already imports `DiffEditor` from `@monaco-editor/react` — wire it as a modal/inline diff before each write
- For each `write_file`/`apply_patch`/`create_file` tool call, show:
  - Old content (left) vs new content (right)
  - "Accept" / "Reject" / "Edit & Accept" buttons
  - "Always accept for this session" checkbox (current auto-accept behavior, but as opt-in)
- Server already streams `tool_call` SSE events with the proposed write — intercept on client before applying to VFS
- Check existing approval flow at [src/components/AIChatPanel.tsx](src/components/AIChatPanel.tsx#L1415) (`onRequestClose={() => handleApprovalResponse(false)}`)

**Effort:** ~2 days. Most of the wiring exists.

#### 2b. Snapshot/rollback for the entire AI run

**Why:** "Undo" today only works at the Monaco-editor level (per file, per keystroke). If the AI modifies five files, there's no way to roll back the whole batch.

**How:**
- Before each `streamServerAgentLoop` call ([src/components/AIChatPanel.tsx](src/components/AIChatPanel.tsx#L740)), snapshot the VFS: `const snapshot = vfs.serializeAll()`
- Store snapshots in a stack (last N runs) in component state or sessionStorage
- Add "Undo last AI run" button to the chat panel header (next to Settings/×)
- `vfs.deserializeFrom(snapshot)` on click
- Optional: visual diff between snapshot and current state

**Effort:** ~1 day.

#### 2c. Live tool-call progress

**Why:** Currently users see "Thinking..." for 3-9 minutes with no indication of what the agent is doing. This is the #1 reason people give up on the AI mid-run.

**How:**
- Server already emits `tool_call`, `tool_result`, `iteration` SSE events ([server/routes/ai.ts](server/routes/ai.ts#L640-L700))
- Render a compact progress strip in the chat panel: `iteration 4/12 · reading globalConfig.json...`
- Show recent tool calls collapsed by default, expandable for output
- Add a "Stop" button that closes the SSE stream and aborts the agent loop server-side (need a cancellation token threaded through `callOpenRouter` and the `while (keepGoing)` loop in [server/routes/ai.ts](server/routes/ai.ts#L599))

**Effort:** ~2 days for display; ~1 more day for proper cancellation.

#### 2d. Model picker (haiku for quick edits, opus for complex tasks)

**Why:** Kimi-k2.6 is overkill for "rename this file" and underpowered for "design this from scratch." Different models for different jobs.

**How:**
- [server/routes/ai.ts](server/routes/ai.ts#L544) already accepts `model` in the request body
- [src/lib/ai/modelProfile.ts](src/lib/ai/modelProfile.ts) defines profiles — add `haiku-fast`, `opus-deep`, etc.
- Add a model dropdown in the AI panel settings, persist to localStorage
- Show estimated cost per profile in the dropdown
- Default policy: haiku for prompts <100 chars, opus for prompts that include "design"/"architect"/"plan", kimi-k2.6 otherwise

**Effort:** ~1 day for picker; +1 day for cost estimates.

#### 2e. Persist conversation history per project

**Why:** Refresh the page = lose the entire AI conversation. Reduces willingness to "try one more thing" with the AI.

**How:**
- Persist messages array to IndexedDB keyed by project (use `idb-keyval` or write a thin wrapper)
- Project key = app name + a UUID generated on first save (store in `.uccproject` file)
- Reload conversation when the same project is opened
- Add "Clear chat" button that purges the persisted log too (already exists at [src/components/AIChatPanel.tsx](src/components/AIChatPanel.tsx) — wire it to also clear IndexedDB)
- Show "n previous conversations" in the panel; allow loading older sessions

**Effort:** ~2 days.

---

### 3. App-inspect integration in the AI loop

**Why:** Splunk's `appinspect` is the gatekeeper for Splunkbase. Today users build the app, run appinspect, see warnings, then manually fix them. The AI should iterate on warnings until clean.

**How:**
- Server already has `/api/agent/appinspect` ([server/routes/agent.ts](server/routes/agent.ts)) and the `appInspect` service ([server/services/appInspect.ts](server/services/appInspect.ts))
- Add an `appinspect_check` tool to the agent's `SERVER_TOOLS` array in [server/routes/ai.ts](server/routes/ai.ts#L82)
  - Returns warnings/errors in a structured format the AI can reason about
- Add a UI affordance: "Validate with appinspect" button in the file editor that triggers a special agent prompt: `Run appinspect_check, then fix any failures iteratively. Stop when clean or after 3 fix attempts per warning.`
- Need a separate `maxIterations` budget for the validation pass (probably 20+) — wire `maxIterations` through the frontend payload

**Effort:** ~3 days. The appinspect integration already works; this is mostly system prompt + UI glue.

---

### 4. Template gallery

**Why:** Today new users hit a blank wizard. Working starter projects let them go from zero to working in 60 seconds and learn by example.

**Initial set (4-5 templates):**
1. **REST API Ingest** — modular input that polls a JSON endpoint with API key auth (the energy-API e2e test scenario, productized)
2. **CSV File Watcher** — modular input that tails a directory and parses CSV
3. **Webhook Alert Action** — alert action that POSTs to an external URL
4. **Custom Search Command** — generating + streaming command with required args
5. **OAuth-authenticated Source** — modular input with OAuth2 (Google/Salesforce-style)

**How:**
- Each template = a `.uccproject` file + helper scripts in a `templates/` directory at the repo root
- Add a "Templates" tab on the home page next to "Create New App" / "Import"
- Clicking a template imports the project (reuse [src/lib/importer.ts](src/lib/importer.ts) flow)
- Each template ships with an annotated README explaining the moving parts
- Bonus: AI-friendly system prompt seed per template ("This is a REST API ingest app. The user may ask you to add fields, change auth, etc.")

**Effort:** ~1 week for the framework + first 3 templates; +2 days each for additional templates.

---

### 5. Build → ship pipeline

**Why:** Today the app helps you author UCC apps but stops at "Download App." Real users still have to set up CI/CD, manage Splunkbase listings, and validate for Splunk Cloud separately.

**Items:**

#### 5a. Generate GitHub Actions workflow
- "Generate CI" button that scaffolds `.github/workflows/build.yml` with: install deps → ucc-gen build → appinspect → upload artifact → optional release on tag
- Templates parameterized by app name + Python version + Splunk Cloud profile (yes/no)
- Output as a file in the VFS at `.github/workflows/build.yml` so it ships with Export Source

#### 5b. Splunkbase metadata editor
- Form for: categories (multi-select), short description, long description (markdown), screenshots (image upload to VFS), support contact, license
- Stored in `.uccproject` or a sidecar `splunkbase.yml`
- Validate against [Splunkbase submission requirements](https://docs.splunk.com/Documentation/Splunkbase) (no live link — this needs a static doc reference)

#### 5c. Splunk Cloud appinspect profile
- Stricter ruleset; today appinspect runs with default profile
- Add toggle in appinspect runner: `--included-tags cloud` or equivalent
- Surface failures with explanations targeted at Cloud restrictions (no compiled binaries, no admin commands, etc.)

#### 5d. One-click "deploy to local Splunk"
- Backend already has `splunkDocker` service ([server/services/splunkDocker.ts](server/services/splunkDocker.ts)) — extend it with a "install app" action that POSTs the built ZIP to the Docker Splunk's REST endpoint
- "Test in Splunk" button next to "Build App"
- Auto-restart Splunk after install
- Show a link to `http://localhost:8000` once installed

**Effort:** ~1 week for all four. Each is small but they need integration testing together.

---

### 6. Live validation everywhere

**Why:** Today validation is squiggly underlines in Monaco. Users miss issues because they only see the file they're currently editing. A "Problems" panel that aggregates all errors across the project is table stakes.

**Items:**
- Aggregate Monaco diagnostics into a Problems panel (bottom of file editor)
- Validate `.conf` files against `.spec` files — backend already has [server/routes/confspec.ts](server/routes/confspec.ts) and [server/services/uccGen.ts](server/services/uccGen.ts)
- "Fix all" button that hands the Problems list to the AI as a single prompt
- Cross-file validation: e.g. an input referenced in `inputs.conf` must have a corresponding entry in `globalConfig.json`

**Effort:** ~1 week.

---

## Quick wins (next batch)

Smaller items that don't deserve their own section but pay off quickly. Pick off in any order.

- [ ] **Refactor [src/components/AIChatPanel.tsx](src/components/AIChatPanel.tsx) (1400+ lines).**
  Currently a god-component. Split into `AIChatPanel` (shell), `ChatMessageList`, `ChatInput`, `AISettings`, `ToolApprovalDialog`, `TodoTracker`. Every change today is risky because of the file size. Effort: ~1 day.

- [ ] **Persist VFS to IndexedDB.**
  Today: refresh = lose all in-progress work (the VFS lives in React state). Use `idb-keyval` to checkpoint VFS on every change with debouncing. Restore on app load. Effort: ~half a day.

- [ ] **Token usage display.**
  OpenRouter returns `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`) in each response. Server already uses OpenRouter — extend [server/routes/ai.ts](server/routes/ai.ts) `readOpenRouterStream` to extract usage from the final SSE event, emit a `usage` SSE event, accumulate in client state, display "Tokens: 12.3k · ~$0.04" in chat panel header. Effort: ~half a day.

- [ ] **Type-safety pass on AIChatPanel.**
  Many `any` casts (search the file for `as any` and `: any`). Tighten in tandem with the refactor above.

- [ ] **Auto-save current file before sending AI prompt.**
  Today users can lose unsaved Monaco edits when AI runs. The AI sees the saved content, not the buffer. Either auto-save before sending or warn.

- [ ] **Dev mode toggle is hard to find.**
  "Dev Mode: OFF" in the top bar. Document what it actually toggles (or remove if vestigial — verify by grepping `devMode`/`isDev` in src/).

- [ ] **Env-driven backend URL.**
  Frontend hits `/api/*` via Vite proxy in dev; in production it assumes same-origin. If users want to deploy frontend separately from the AI server (CDN-style), this breaks. Add `VITE_BACKEND_URL` and use it in [src/components/AIChatPanel.tsx](src/components/AIChatPanel.tsx) `fetch` calls.

- [ ] **Test 2 was a false positive — verify other tests too.**
  Ran a quick check: tests 1-9 all assert specific behaviors except test 2 (which we just fixed). But [tests/e2e/build_wizard.spec.ts](tests/e2e/build_wizard.spec.ts) and [tests/e2e/smoke.spec.ts](tests/e2e/smoke.spec.ts) are worth a careful re-read — make sure each test would actually fail if the feature broke.

---

## Longer-term differentiators

Speculative bets — high effort, high uncertainty, high payoff if they land.

- **Pyodide-based test runner.** Run pytest on Python helper scripts in-browser. No backend Python needed. Lets users TDD their modular inputs without leaving the app.

- **Searchable Splunk SDK browser.** Index `splunklib`/`solnlib` reference docs. Today the AI has a tiny `SPLUNK_HELP` dict in [server/routes/ai.ts](server/routes/ai.ts#L67) — replace with a real semantic search.

- **App-inspect telemetry.** Track which warnings users hit most. Feed top warnings into the AI's system prompt as "common pitfalls." Closes the loop between real user pain and AI guidance.

- **"Compare against best practice."** Curate 5-10 high-quality reference UCC apps (Splunkbase top-rated). Diff user code against the closest reference. Surface deltas as suggestions.

- **Mobile/tablet preview.** Show what the configured Splunk UI will look like (the `pages.inputs` form rendered in the Splunk shell). Critical for non-developer users (sales engineers, demo authors).

- **Collaborative editing.** Multiple users on the same project, CRDT-based. Probably not worth it until single-user UX is dialed in.

- **Plugin system.** Let users add custom AI tools (e.g. "validate against my company's internal naming convention"). Probably wait until v2.

---

## Tech debt & infrastructure

Things to clean up that will save time on every future change.

- **Vite config trap solved.** [vite.config.js](vite.config.js) was overriding [vite.config.ts](vite.config.ts) silently. Deleted + gitignored. Don't undo.

- **`vitest/config` vs `vite/defineConfig` trap solved.** `vitest/config`'s `defineConfig` drops the `server` property silently. Use `import { defineConfig } from 'vite'` with `/// <reference types="vitest" />` (current state of [vite.config.ts](vite.config.ts)). Don't undo.

- **`maxIterations` is server-default.** [server/routes/ai.ts](server/routes/ai.ts#L568) defaults to 12. Frontend never sends a value. If we add complex multi-file tasks (#3 above), thread `maxIterations` through the frontend payload so different task types get different budgets.

- **Planner is a separate API call.** [server/routes/ai.ts](server/routes/ai.ts#L588) does a non-streaming planner call before the main loop. Adds 5-10s and costs tokens. Reconsider once we have model picker — for haiku-tier models, skip the planner.

- **Local docs index status unclear.** [server/services/localDocsIndex.ts](server/services/localDocsIndex.ts) exists; `consult_documentation` tool wires it up; but in our test runs it returned no useful results. Either populate it or remove it.

- **Test 3 (AI modifies globalConfig) is intermittently flaky.** Same code passes in some runs, fails in others — kimi-k2.6 sometimes reads globalConfig.json and stops without writing. Symptoms: test runs full 9-minute timeout, body text shows file contents but no "Successfully wrote" message. Workaround in place: `retries: 1` locally (`retries: 2` in CI) — see [playwright.config.ts](playwright.config.ts). Real fix needs one of: (a) better system prompt that forces the write, (b) deterministic completion check (verify VFS state instead of chat text), (c) switch to a more reliable model. Test timeout is 600s in [tests/e2e/ai_energy_api.spec.ts](tests/e2e/ai_energy_api.spec.ts). Inherent cost: the full AI test takes 3-9 minutes; consider a CI tier where PR-time runs only fast tests and nightly cron runs the full AI suite.

---

## Past decisions worth remembering

Brief notes so future-you doesn't re-litigate these.

- **Server-side AI loop chosen over client-side.** Originally the AI ran in-browser; moved server-side so OpenRouter API keys aren't exposed and tool execution can be audited. Stick with this.

- **Single-model loop (kimi-k2.6) chosen over planner/router/executor split.** Simpler, cheaper, behaves well on UCC tasks. The infrastructure for multi-model exists in [src/lib/ai/modelProfile.ts](src/lib/ai/modelProfile.ts) — switch profiles to enable.

- **VFS not persisted by design (originally).** Was intentional to keep the model "what you see is what gets ZIPped." Item #2 above (persist to IndexedDB) reverses this — make sure the persistence is opt-in or has clear "start fresh" affordance.

- **Auto-accept tool actions defaults to OFF.** Critical for trust early on. Item #2a (diff review) is the better pattern long-term.

---

## How to pick this up next session

1. **Re-read** this file + [ROADMAP.md](ROADMAP.md) for product status + [DEVELOPER_CONTEXT.md](DEVELOPER_CONTEXT.md) for codebase orientation.
2. **Run the tests** — confirm green baseline: `cd apps/ucc-app-builder && npm run test:e2e`. AI test takes ~5 min so consider `--grep` for fast iteration.
3. **Pick one item** from Strategic Priorities or Quick Wins. Don't try to combine.
4. **For UI work,** start the dev servers (`npm run dev` and `npm run dev:server` in separate terminals) and test in browser before wiring tests.
5. **For AI/server work,** the agent loop is in [server/routes/ai.ts](server/routes/ai.ts) — most changes happen there. Restart the backend after edits (`tsx watch` should auto-reload, but verify).
