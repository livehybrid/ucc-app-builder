# Research Q5 — UX patterns for non-developer agent-chat + approval workflows

> Source: Perplexity Pro (Nov 2026). Raw response extracted from the Perplexity desktop app.
> Target user: Splunk admin / IT user who can copy-paste but can't write Python.

## 1. Progressive disclosure of technical detail

For non-developers like a Splunk admin who can copy-paste but not code in Python, progressive disclosure is a core UX pattern: **start with plain-English summaries of changes, then offer toggles or expanders for raw diffs or code**. This reduces cognitive load by hiding complexity until requested, improving reasoning and trust.

- **Lovable** uses layered revelation for non-designers, showing high-level prototypes first before code details.
- **v0 (Vercel)** generates UI from natural language for non-technical users (e.g., product managers), previewing styled components with code export on demand — no upfront diffs.
- **Replit Agent** excels for non-devs by describing plans in English before changes, allowing "explain first" prompts to avoid overwhelming interfaces.

**Recommendation:** Default to summaries with a prominent "Show diff/code" toggle; track user preference per session.

## 2. Approval workflows

Require approval for high-risk actions (file writes, deploys, external calls); auto-run low-risk reads or local tests.

- **Claude Code's allowlist model** (`permissions.allow` rules) pre-approves safe tools (e.g., reads), with modes like `acceptEdits` for working-dir changes and `auto` (classifier-checked) for trusted flows — ideal for non-devs via granular control.
- **Cursor** offers auto-apply toggles (e.g., Inline Diffs off for auto-keep), reducing clicks but with easy undo via settings.
- **Aider** uses simple yes/no prompts or `--yes` for auto, but suggests granular configs for safety.

**Best for a Splunk admin:** Allowlist common UCC tasks (e.g., ucc-gen reads); prompt yes/no for container spins or multi-file edits; use conversation boundaries (e.g., "don't deploy") as soft blocks.

## 3. Surfacing plans / todos and progress

Combine inline chat messages for immediate context with a sidebar checklist for overview — **both is optimal for multi-file workflows**.

- **Inline**: Agent posts numbered plans (e.g., "1. Update auth.py → SAML"), progress ticks (✅ Done), and todos.
- **Sidebar**: Persistent checklist with indeterminate progress bars for long tasks like container builds.
- **Patterns from agent IDEs**: Cursor sidebar for context-sensitive tasks; Replit uses inline explanations + file nav.

**For Splunk UCC:** Show `ucc-gen` output inline, with sidebar for build steps (e.g., "Build UI → Copy to static → Spin container").

## 4. Handling "agent is stuck / hallucinated" cases

Gracefully detect via confidence scores, timeouts, or repeated failures; respond with transparency (e.g., "I'm uncertain — here's why") and recovery options: suggest alternatives, show sources, or handoff to human.

**UX patterns:**
- Warnings like "Low confidence (60%) — verify?"
- Multiple options, or "Regenerate / Refine" buttons.
- NN/g recommends **undecided language** and verification tools to build trust without overwhelming non-devs.

**For a Splunk admin:** Flag hallucinations in Python/SPL (e.g., invalid queries) with plain-English explanations and a "Fix & retry" button.

## 5. Preview / live testing feedback loop

- **Bolt.new's WebContainers** enable in-browser VMs for instant previews (e.g., `npm install` → run), minimising latency vs. cloud spins — no cold starts, secure (user CPU only).
- **Replit** offers realtime cloud previews with Agent handling deps automatically, accessible for non-devs.

**For Splunk UCC (`ucc-gen` → container launch) — feasibility:**
- Inline logs from `./scripts/quick_start_ui.sh` or `run_splunk.sh`.
- Sidebar progress for build / test cycle.
- "Preview" button triggers local Docker spin with streamed output — emulate Bolt's low-latency via persistent containers.
- Limit to read-only previews for safety.

## 6. Chat memory

**Yes — remember per-project decisions** (e.g., "use SAML not OAuth") via project-scoped memory, isolating context to avoid bleed. Essential for multi-file / long sessions.

- **ChatGPT Projects** use "project-only memory" for focused recall from that project's chats / files, with opt-in for non-project refs.
- **Implementation:** Store key decisions in a `.agent-memory.md` file (progressive-disclosed), reload on session start; UX toggle "Forget project X".
- Engineering blogs stress **composable, auditable memory** for trust.

## Key takeaways

- Prioritise plain-English + toggles for non-devs; learn from Lovable / v0 / Replit's accessibility.
- Allowlist + modes (Claude / Cursor) balance speed / safety for UCC workflows.
- Inline + sidebar for plans; transparent handling for errors; container-streamed previews; project memory for continuity.

## Implications for UCC App Builder

1. **Default view = plain English summary** of what the agent did, with an expandable "Show diff" / "Show generated code" toggle. Files still visible in the IDE tree for the curious.
2. **Two-tier approval model**:
   - Auto-run: `list_files`, `read_file`, `consult_docs`, `get_stanza_spec`, dry-run validation.
   - Require confirmation: `apply_patch` / `write_file`, `build_app` (ucc-gen), `run_container`, any action on `bin/` Python scripts.
   - Persist user-level allowlist in settings ("don't ask me again for config edits in this project").
3. **Dual progress display**:
   - Inline messages in chat with numbered plan items and ✅ / 🔄 / ❌ state.
   - Persistent sidebar checklist (Plan panel) showing current todo list from the Planner's `TodoWrite` tool calls.
4. **Stuck / failure UX**:
   - Detect ≥3 consecutive tool failures or >N iterations without progress → agent pauses and says "I'm stuck on X — would you like to: (a) try a different approach, (b) manually fix and let me continue, (c) ask for human help?".
   - Show uncertainty when the Planner itself is under a confidence threshold.
5. **Preview as a deferred feature** — Phase 2. For MVP: inline `ucc-gen` output + "Copy command to run locally" button. Phase 2: persistent Splunk container with log streaming, similar to Bolt's WebContainer feel but server-side.
6. **Project memory file**: `.ucc-agent/decisions.md` committed in the project; auto-injected into the system prompt on session start. Manually editable by the user. Populated via an internal `record_decision` tool when the agent detects a significant architectural choice (e.g., "we're using SAML not OAuth"). UI shows recent decisions in a "Memory" tab.
