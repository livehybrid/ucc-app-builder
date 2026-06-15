# Demo Script — UCC App Builder (under 3 minutes)

> Goal: show an AI agent that builds a Splunk add-on and **self-corrects until it
> passes AppInspect** — surfaced live in the UI and exposed as MCP tools.

Total runtime target: **~2:45**. The whole demo is deterministic (no LLM needed), so
it reproduces every time.

---

## 0:00 — The problem (15s, talking head / title slide)

> "Getting a Splunk add-on through **AppInspect** is a slow expert loop: scaffold with
> `ucc-gen`, package, run `splunk-appinspect`, read the findings, fix the *right* file,
> rebuild, re-inspect. Beginners fix `app.conf` — which ucc-gen overwrites every build —
> and go in circles. We closed that loop with an AI agent."

## 0:15 — The money-shot: the Build Loop panel (60s, screen capture)

1. `npm run dev:all` (or `PORT=3011 npm run dev:all` if 3001 is taken). Open the UI.
2. Click **Build Loop** in the nav.
3. The spec box is pre-filled: *"Build a Splunk add-on 'GitHub Audit' that collects
   github repository audit events from the GitHub API using an api token for a given org."*
4. Click **Build & self-correct**. Narrate the live trace as it streams:
   - 🔨 `build` — ucc-gen builds + packages the add-on
   - 🔎 `inspect` — splunk-appinspect finds **1 actionable check**
     (`check_for_updates_disabled`)
   - 🩹 `fix` — the agent sets `meta.checkForUpdates=false` in **globalConfig.json**
     (not app.conf — narrate the trap)
   - 🔁 iteration 2 → 🔎 `inspect` — **0 actionable checks** → ✅ **CLEAN**
5. Point at the **green CLEAN** banner + the downloadable `TA_github_audit-1.0.0.tar.gz`.

> "That's a real ucc-gen build and a real splunk-appinspect run, self-corrected to a
> clean package — no human in the loop."

## 1:15 — The CLI proof, both add-on shapes (35s, terminal)

```bash
npm run loop -- --no-llm                                  # config-only → CLEAN
npm run loop -- --no-llm fixtures/input-addon.project.json # input-bearing → CLEAN
```

> "Same loop on the CLI. The input-bearing case is the hard one — it pulls in
> solnlib/splunktaucclib. We pin `solnlib<8` to dodge AArch64-incompatible native
> binaries, map `password` fields to encrypted text (UCC has no password type), and drop
> the files AppInspect forbids. Both reach CLEAN deterministically."

(These exact runs are recorded under `transcripts/`.)

## 1:50 — MCP: an external agent builds it conversationally (40s, terminal)

```bash
npx tsx tools/mcp-record.ts   # or wire `npm run mcp:server` into Claude Desktop
```

Show the JSON-RPC session scroll by:
`initialize` → `tools/list` (5 tools) → `create_addon` → `add_input` (with a secret
field) → `package_app` → **AppInspect-CLEAN** package.

> "The builder is also an **MCP server**. Any agent — Claude Desktop, the Splunk AI
> Assistant — can call `create_addon`, `add_input`, `package_app` and get the same
> self-correcting build. And it *consumes* the Splunk MCP Server too, grounding input
> suggestions in your live indexes."

## 2:30 — Close (15s)

> "An agent that builds Splunk add-ons and makes them AppInspect-clean by itself —
> in the UI, on the CLI, and over MCP. 305 unit tests, browser tests, and a CI job that
> proves the loop reaches CLEAN on every push. Clone it and watch it go green."

---

## Pre-flight checklist

- [ ] `pip install "splunk-add-on-ucc-framework==6.4.0" "splunk-appinspect==4.2.1"`
- [ ] `npm install`
- [ ] (UI demo) decide the port: `PORT=3011 npm run dev:all` + `VITE_API_URL=http://localhost:3011/api`
- [ ] First `ucc-gen build` downloads Python deps into `lib/` — **warm the cache once**
      before recording so the demo isn't waiting on pip.
- [ ] No API key needed: everything above runs with `--no-llm` / `useLlm:false`.
