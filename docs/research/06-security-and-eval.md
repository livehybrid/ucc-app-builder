# Research Q6 — Security, guardrails, evaluation for code-gen agents

> Source: Perplexity Pro (Nov 2026). Raw response extracted from the Perplexity desktop app.
> Context: hosted SaaS Splunk UCC app builder; agent generates Python modular inputs and `.conf` files on behalf of users.

## 1. Filesystem sandboxing

Platforms like Lovable, Replit, and Bolt employ distinct isolation strategies for per-user project directories:

- **Lovable** leverages **Modal Sandboxes with gVisor** for kernel isolation, scaling to thousands of concurrent containers via serverless fabric, dedicating state per sandbox to minimise shared kernel risks.
- **Replit** uses separate filesystems, network restrictions, and resource limits (CPU / RAM / storage) per container, preventing cross-project access without privileged modes.
- **Bolt** relies on **WebContainers** (browser-based via StackBlitz), offering client-side isolation but requiring server-side review for generated code. No native server-side containers per session.

Common approaches:
- **Containers per session** (gVisor, Firecracker microVMs in E2B / Daytona) for strong boundaries.
- **Path validation** (`openat2` for write confinement).
- **Chroot** (weaker visibility walls).

**Recommendation for Splunk UCC app builder:** gVisor or Firecracker microVMs per session in Docker, layering namespaces / PID isolation and ephemeral `tmpfs` to confine `.conf` and Python modular inputs to user dirs, avoiding shared-kernel exploits.

## 2. Prompt-injection defenses (2026)

Beyond system-prompt hardening, current best practices for agents processing fetched docs / SPL include:

- **Multi-layer classifiers**: banned-word / regex matching, LLM contextual detectors, and DeBERTa-style models for nuanced injections.
- **Sequential pipelines with coordinator agents** to neutralise embedded instructions.
- **Spotlighting** (highlighting user vs. system content) combined with **delimiter sentinels** (e.g. XML / JSON wrappers) and classifier-based filters (e.g. multi-agent detection) outperform rules alone, especially for SPL queries in UCC generation.
- **Pre-processing**: validate SPL syntax, sandbox fetched docs in read-only `tmpfs`.

## 3. Code-execution safety

| Platform | Sandbox | Model |
|---|---|---|
| **Bolt WebContainers** | Browser sandbox — no server escape | Limited to Node.js / review workflows |
| **Replit** | **Nix sandboxes** (bubblewrap + namespaces via `jail.nix`) | Linux-only untrusted code, preset envs (Python / Node) |
| **Cursor / Claude Code** | Write-only model or **devcontainer sandboxes** (Docker / VM with Landlock / seccomp) | Mount projects read-write but block network / secrets |

**For `ucc-gen` + Splunk container:** adopt **gVisor** (user-space kernel, ~70 host syscalls) or **Firecracker microVMs** (hardware boundary) in per-session containers; validate modular inputs via Splunk's `--validate-arguments` and AppInspect, avoiding execution until review.

## 4. Eval harnesses

| Harness | What it measures | Relevance |
|---|---|---|
| **SWE-bench** | Real software engineering (GitHub issues) | Medium — repo navigation, edits |
| **Terminal-bench** | CLI / agent ops | High — agent IDEs score Claude Code ~52–66% |
| **tau-bench** | Multi-turn workflows | Medium — plan / execute loops |
| **MLE-bench** | ML engineering tasks | Low — not UCC-shaped |

All benchmark Python / config generation and repo navigation, so some components transfer.

### DIY "UCC-bench" (30 tasks)

- **10 basic**: generate `.conf` for TCP / UDP inputs, SPL validation.
- **10 intermediate**: modular-input Python for S3 / REST API pull, health dashboards.
- **10 advanced**: auth handlers, multi-instance stanzas, error checkpointing.

Score on:
1. Syntax validity (`props.conf.spec` / `inputs.conf.spec` compliance).
2. Splunk ingestion success (actually ingests data).
3. AppInspect pass rate.

Run via a **Terminal-bench registry adapter** so it plugs into existing tooling.

## 5. Regression testing across model versions

Use:
- **Snapshot tests** — trace / replay prompts / tool calls / outputs (`agentcheck`, `VCR.py`-style).
- **Offline replay** — frozen inputs, diff behaviours.
- **Frozen prompts** to validate UCC outputs across models.
- Replay SPL / doc traces; assert `.conf` syntax / `inputs.conf.spec` compliance.

## 6. Observability

| Tool | Notes |
|---|---|
| **Langfuse** | Open-source, broad tracing, self-host |
| **Helicone** | Zero-code proxy |
| **OpenLLMetry** | OpenTelemetry-style; traces similar to Langfuse |
| **Braintrust** | Evals + experiments (complement, not replacement) |

### What to log per agent session

- Traces: prompts, responses, tool calls.
- Latencies (per tool, per model, end-to-end).
- Cost (tokens × rate, split by Planner / Executor / Router).
- Injections detected (rule + classifier verdicts).
- Eval scores (UCC-bench grade for generated app).
- Session metadata (user id, project id, model versions in use).

For Splunk dev flows, Langfuse / Helicone are proxy-less wins — they capture modular-input test executions too.

## Key takeaways

- Prioritise gVisor / microVMs for UCC sandboxing, multi-layer prompt filters, write → review → execute flow.
- Benchmarks: adapt Terminal-bench / SWE-bench → UCC-bench.
- Observability: Langfuse as the default, Braintrust on top for evals.
- Ensures secure, evals-driven UCC app building in SaaS.

## Implications for UCC App Builder

1. **Sandbox architecture (SaaS tier)**:
   - Per-session Firecracker microVM (or gVisor container) holding the user's project files under `/workspace/<session>`.
   - Agent tool-execution runs inside the same microVM with strict egress rules (only OpenRouter endpoints + Splunkbase / Splunk docs cache).
   - `ucc-gen` and Splunk container spin-up happen in a sibling short-lived container, results streamed back.

2. **Path validation (self-hosted tier)**:
   - Keep the existing `isPathSafe` / project-root-scoped check as the minimum bar.
   - Add `openat2` (Linux) / equivalent for all file writes to prevent `..` escapes.

3. **Prompt-injection pipeline**:
   - Wrap all user-supplied SPL and all fetched doc chunks in explicit `<untrusted_user_input>` / `<untrusted_fetched_doc>` tags (spotlighting).
   - Run a cheap classifier (DeBERTa-v3 injection-detector) on any doc chunk before injection.
   - Strip / escape any `<tool_call>` / function-call-looking text in user inputs.

4. **Execution safety**:
   - Treat `build_app` (ucc-gen) as privileged — always require explicit user approval.
   - Run every AppInspect + Splunk `btool check` automatically before allowing a deploy step.
   - Never run arbitrary Python; only the generated script inside the sandbox.

5. **UCC-bench**:
   - Build 30 scripted tasks under `apps/ucc-app-builder/eval/ucc-bench/`, each a folder with `task.md`, `expected/` artefacts, and a grading script.
   - Runner loads the task prompt, invokes the agent, checks the grading script output.
   - Integrate into CI as a nightly cron against both pinned and latest model versions.

6. **Regression + snapshot testing**:
   - Record golden traces for each UCC-bench task with the reference model.
   - On agent-code changes, replay traces offline and diff tool-call sequences.
   - On model upgrades, re-run UCC-bench and compare grades.

7. **Observability stack**:
   - Wire Langfuse (self-hostable) as the primary trace sink.
   - Log `session_id`, `user_id`, `project_id`, `planner_model`, `executor_model`, `tool_name`, `tool_input_hash`, `tool_output_hash`, `tokens_in`, `tokens_out`, `latency_ms`, `cost_usd`, `ucc_bench_score` (if applicable), and any injection-classifier verdicts.
   - Expose a dashboard to surface top failing tools, highest-cost sessions, and injection attempts.
