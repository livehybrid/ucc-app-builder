# Q3 — Tool Design Patterns for Agentic Coding (2026)

**Source:** Perplexity "Best" mode, Q3 thread.

---

## 1. File-Editing Tool Patterns: apply_patch vs. Full-File Rewrite vs. Structured-Edit

**apply_patch / unified diff / edit_file with search-replace strings** (used in Claude Code, Cursor, OpenAI Agents SDK) generates precise diffs or search-replace strings for minimal changes, preserving existing code, comments, and formatting. Token-efficient for large files and reduces drift. OpenAI's `apply_patch` tool supports create/update/delete via diffs applied to workspaces.

**Full-file rewrite** (e.g. early Bolt.new) outputs entire files — simpler for models but fails on large codebases by introducing unnecessary changes, losing comments/formatting, bloating diffs, and scaling poorly with token limits/costs.

**Structured-edit** (e.g. Morph) uses syntax-aware embeddings, reranking, and AST-respecting "fast apply" for precise retrieval/editing. Excels in codebase navigation and avoids "diff-patch chaos" where patches break code.

### Common Failures

| Pattern | Common Failures |
|---|---|
| **apply_patch** | Hallucinated hunk offsets / context (wrong line numbers), partial diffs missing dependencies; agents "fix" correct code. |
| **Full-rewrite** | Semantic breaks, formatting loss, irrelevant changes; inefficient for iterative edits. |
| **Structured-edit** | Retrieval misses in massive repos; over-reliance on embeddings fails novel patterns. |

### Correction Loop for Hallucinated Patches

Agents self-reflect (evaluator-optimizer pattern), re-apply with verification tools (tests / diffs), or abstain if uncertain. Humans approve via `needsApproval` in OpenAI SDK. Research shows reflection boosts coding accuracy **+20pp to 91%**.

## 2. Planning Tools: Explicit `plan`/`todo` vs. Implicit CoT

- **Explicit tools** like Claude Code's `TodoWrite` force decomposition into checklists (~5–10% of all invocations), enabling progress tracking and reducing hallucination via structured steps.
- **Implicit Chain-of-Thought** relies on model reasoning but drifts in complex multi-step tasks.

**Evidence:** Explicit planning suits agentic coding (orchestrator-workers pattern) and outperforms implicit CoT for multi-step tasks per Anthropic/Anthology reports. `TodoWrite` ensures observability. TeamDay.ai recommends explicit for production — implicit fails without guardrails.

**Recommendation:** Use explicit `TodoWrite`-style for Splunk UCC multi-file generation to decompose into modular inputs, configs, validation.

## 3. Subagent / Delegation Tools

Spawn subagents via a `Task` tool for isolated subtasks (e.g. one for `globalConfig.json`, one for `.conf`). Prevents context pollution in main window.

**Context passed to subagent:** minimal — task spec, relevant files/summaries, project constraints (e.g. Splunk UCC schema). Subagent returns summaries, not raw file contents.

**Evidence of improvement:** Multi-agent boosts via parallel reasoning / separate contexts (Trend 2, Anthropic) — **~50% faster workflows** in Anthropic's examples.

**When to delegate:** when subtasks exceed ~1K tokens of context, or are specialised (e.g. validation subagent).

## 4. Domain-Specific Tools for Splunk UCC

High-level tools like `add_config_entity(name, type, fields)` or `generate_modular_input(input_spec)` **beat raw file-edits when structure is rigid** (JSON / .conf schemas). Reduces hallucination vs. free-form patches.

**Where to draw the line:** use domain tools for ~80% of boilerplate (configs, inputs), fall back to raw edits for **custom Python logic**. Validate via `validate_globalConfig()` after structural changes.

**Reliability:** Domain tools > raw edits per "tools for LLM consumption" best practices; structured > prose for consistency.

## Key Takeaways

- **Prefer apply_patch + structured-edit** for precision; keep full-rewrite only for net-new small files (< ~200 LOC).
- **Explicit planning (`TodoWrite`) + subagents** for complex multi-file UCC generation.
- **Domain tools for Splunk structure** — rigid schemas benefit most.
- **Multi-agent orchestration** is a key differentiator for 2026 agentic coding success.

## Implications for UCC App Builder

1. **Replace the current `write_file` full-rewrite tool** with a three-tool set:
   - `apply_patch(path, search, replace)` — primary edit tool for existing files
   - `create_file(path, content)` — only for brand-new files
   - `read_file(path)` — already exists; add line-anchored reads for large files
2. **Add a `TodoWrite`-style tool** that the planner calls at the start of a task to emit a plan; UI shows the plan, executor ticks off items.
3. **Add a `Task` (subagent) tool** that spawns a child session with a subset of context. Start with just one subagent: a "config-writer" that specialises in `globalConfig.json` changes.
4. **Promote our existing domain tools** — `generateInputScript`, `addConfigEntity`, `getSplunklibHelp`, `validate_globalConfig` — to the **front of the tool list** in the system prompt; demote `write_file` to "escape hatch for custom code".
5. **Build a correction loop** — on `apply_patch` failure (mismatched hunk), auto-retry with a re-read of the file and a `why_did_this_fail` reflection step (implement with a single cheap Sonnet call).
