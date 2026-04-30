# Q1 — Competitor Agent Architectures (Lovable, v0, Bolt, Replit, Cursor, Claude Code, Windsurf)

**Source:** Perplexity "Best" mode (auto-routed), 2026-04-22

---

## 1. Lovable

- **Loop shape:** Simple, non-agentic "hydration" pattern. Fast smaller models select context first, then hand off to a single larger model for code generation. Prioritises speed over multi-step iteration. Rejected multi-agent setups after A/B testing showed lower accuracy and user confusion.
- **LLMs:** OpenAI GPT-4o Mini for fast initial processing / context selection + Anthropic Claude 3.5 Sonnet for complex code generation.
- **Tools:** Search-replace operations, parallel file views/edits. Leaked prompt example: _"examine the current button component and utils file, then make the requested changes efficiently"_ with parallel tool calls.
- **Multi-file edits:** Full file rewrites or targeted modifications via search-replace; prompts instruct _"rewrite the entire file or modify the existing content"_ but emphasise minimal changes to relevant sections only to avoid error loops.
- **Context management:** LLM-powered intelligent file selection — smaller models pick relevant files (not dumping all codebase, which "deteriorates performance"). Uses project Knowledge Base (PRD, user flow, tech stack) for focused context.
- **Iteration / preview:** Prompt queue for batching (pause/resume/reorder up to 50 repeats). Agent mode implements/verifies changes end-to-end with console log access for debugging. Users review diffs before apply.
- **Leaked system prompt insights:** _"You are Lovable, an AI editor… making changes to their code in real-time… GOOD EXAMPLE: Parallel tool calls… using search-replace operations"_ — emphasises efficient tool usage, reasoning before edits.

## 2. v0 by Vercel

- **Loop shape:** Multi-step agentic pipeline with dynamic system prompts, "LLM Suspense" (streaming manipulation), and post-generation autofixers. Plan-then-execute with deterministic fixes.
- **LLMs:** v0 Composite Model Family (custom-tuned, likely based on GPT-4o / Claude variants). Integrates Vercel AI SDK for agent orchestration.
- **Tools:** AI SDK tools like `generateText`, `tool()` for custom functions. Supports max-step caps (e.g. `stepCountIs(5)`) in loops.
- **Multi-file edits:** Not explicitly detailed; agentic flow implies coordinated changes via tool calls in conversation history.
- **Context management:** Streaming conversation history with tool results appended. Dynamic prompts for relevance.
- **Iteration / preview:** Autofixers run after streaming; agent loop repeats until max steps or text response. Real-time previews in UI.
- **Leaked prompt insights:** Engineering blog emphasises "dynamic system prompt" and "LLM Suspense" for reliability.

## 3. Bolt.new

- **Loop shape:** Agentic with environment control — plans/iterates autonomously (reads errors, fixes before asking). Not pure ReAct but iterative on failures.
- **LLMs:** Primarily Anthropic Claude 3.5 Sonnet leveraging 200k context. No RAG — relies on history.
- **Tools:** Full control over filesystem, node server, package manager, terminal, browser console. Examples: view file, create new, replace entire.
- **Multi-file edits:** **Full file replacements only** — _"Never use incremental editing"_. Protocol: view → create new version → replace. Coordinates multi-file for features.
- **Context management:** Conversation history with all prior code/errors (no RAG). Claude's large window handles codebase via messages.
- **Iteration / preview:** Autonomous error-fixing loops. Live browser previews via **WebContainers**. Deploys/shares via URL.
- **Leaked prompt insight:** _"// File Modification Protocol: IF file exists… 1. View current content 2. Create new version… 3. Never use incremental editing // Safety Advantages: Prevents accidental file corruption"_.

## 4. Replit Agent v2/v3

- **Loop shape:** Orchestrator-based (Replit Agent Orchestrator for complex tasks). Hierarchical: intent classifier → agent for multi-step autonomy.
- **LLMs:** Multi-model including Ghostwriter (low-latency) + frontier models. Dynamic memory compression.
- **Tools:** Project scaffolding, DB provisioning, secrets, API gen, runtime exec, deployment. Runtime error capture feeds the loop.
- **Multi-file edits:** 10× autonomy for complex multi-file projects; auto-fixes bugs/tests.
- **Context management:** Dynamic prompt construction / memory management — LLMs compress long trajectories. RAG for chat / Q&A.
- **Iteration / preview:** Realtime app preview (live rendering). Error detection / auto-fixing loops. One-click deploy.
- **Workflow:** _"Intent Classifier → Replit Agent Orchestrator"_. Memory truncation via LLMs.

## 5. Cursor Agent

- **Loop shape:** Agent-first with **Composer** (multi-file agent mode) — plans modifications across files, reviews/applies. Parallel agents (up to 8).
- **LLMs:** Composer model + RL-trained for code/agent tasks. Frontier models.
- **Tools:** Terminal commands, repo-wide changes. MCP integration.
- **Multi-file edits:** Plans modifications across relevant files. Individual review/apply per file.
- **Context management:** Workspace index / RAG auto-assembles context. Tree summarisation implied for large repos.
- **Iteration / preview:** Review proposed changes. Parallel agents in Git worktrees. Auto-refactors.
- **Leaked prompt insight:** _"Composer plans modifications… Review the proposed changes"_.

## 6. Claude Code

- **Loop shape:** Master agent loop with iteration on failures/tests. Multi-turn with tools.
- **LLMs:** Anthropic Claude 3.5 Sonnet (1M context). Agent teams / parallel specialists.
- **Tools:** `Edit` (patches/diffs), `Write/Replace` (full files), `Bash` (shell with risk prompts). Git integration.
- **Multi-file edits:** Surgical patches or full rewrites. Reads entire project.
- **Context management:** Full project read + 1M window. No explicit RAG mentioned.
- **Iteration / preview:** Runs tests / iterates on failures. `/loop` for recurring. Voice / MCP servers.
- **Leaks:** Detail system architecture; tools block injections; CLI diffs for review.

## 7. Windsurf

- **Loop shape:** Agentic with reasoning rules. Likely ReAct-like via RAG prompts.
- **LLMs:** Not specified; optimised for code suggestions.
- **Tools:** Codebase indexing tools; remote repo support.
- **Multi-file edits:** Handled via context-rich prompts (not detailed).
- **Context management:** Optimised RAG over codebase / past actions / next intent. Avoids fine-tuning scalability issues.
- **Iteration / preview:** Context builds understanding for iterative suggestions.
- **Leaked insight:** _"Construct highly relevant, context-rich prompts"_.

---

## Key Takeaways

- **Most products use simple / non-agentic loops** (Lovable-style hydration) or tool-orchestrated agents (v0, Bolt) for reliability. Full ReAct is rarer.
- **Claude Sonnet dominates** (Bolt, Lovable, Claude Code). Multi-model hydration (small-picks-context, big-writes-code) is a recurring pattern.
- **Full rewrites + search-replace prevail** for edits. Bolt explicitly bans incremental editing. Lovable uses search-replace but within minimal scope.
- **Context strategies split into two camps:**
  - **Giant-window / no-RAG:** Bolt, Claude Code (200k–1M context)
  - **RAG / LLM-selected context:** Lovable, Cursor, Windsurf
- **Leaks reveal prompts emphasising safety, reasoning before action, and parallel tool use.**

## Implications for UCC App Builder

1. **Hydration pattern** (cheap model picks files → Sonnet-tier writes) is probably the right default — Lovable's A/B testing validated it.
2. **Full-file rewrites** are safer than diffs for small/medium files (globalConfig.json, helpers < 500 LOC). Diffs/search-replace become valuable once files are large — we likely need both.
3. **Hierarchical orchestrator** (Replit, Cursor Composer) is how to get multi-file UCC generation right — one "planner" agent decides _which_ files to touch, per-file subagents do the edits.
4. **Preview is ubiquitous.** We said preview is nice-to-have — but Bolt's WebContainer + Replit's live preview are genuinely table-stakes for the non-coder audience. Worth revisiting after MVP.
5. **Prompt queues** (Lovable's batch pause/resume) are a differentiator for Splunk admins who want to say "now add another input, then fix the alert, then build" in one go.
