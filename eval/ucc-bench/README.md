# UCC-bench

A small, community-extensible evaluation harness for the Splunk UCC **agent**.

The runner (`runner.ts`) executes each task **end-to-end against the same tool-calling
agent the product ships** (`server/routes/ai.ts` exports `SERVER_TOOLS`; the loop core is
`server/services/agentRunner.ts`), then grades the agent's output on three axes:

- **syntax** — every `package/bin/*.py` parses under `python3`.
- **build** — `ucc-gen build` + package succeeds.
- **appinspect** — `splunk-appinspect` reports no failures.

The build + appinspect grades reuse the production self-correcting loop
(`server/services/agentLoop.ts`), so the bench measures exactly what we ship.

Each task lives under `tasks/<name>/`:

- `task.md` — the prompt the agent receives (also declares the target `App id`).
- `metadata.json` — `{ "difficulty": "easy|medium|hard", "tags": [...] }`.

## Running

```bash
# Validate task definitions only — no API, no cost, CI-safe:
npx tsx eval/ucc-bench/runner.ts --dry-run

# Full run against the agent (needs OPENROUTER_API_KEY). anthropic-multi recommended:
MODEL_PROFILE=anthropic-multi npx tsx eval/ucc-bench/runner.ts

# One task:
MODEL_PROFILE=anthropic-multi npx tsx eval/ucc-bench/runner.ts --task simple-rest-poll

# Tune the agent's turn budget / machine-readable output:
npx tsx eval/ucc-bench/runner.ts --max-iterations 22 --json
```

Each full run writes a transcript to `results/<mode>-<timestamp>.json` (and
`results/latest-full.json`) with per-task grades, the agent's tool-call sequence, the
final file list, and the grading build log.

## Tasks

- `simple-rest-poll` (easy) — verified end-to-end **CLEAN** (syntax+build+appinspect).
- `alert-action-webhook` (medium)
- `custom-command-enrich` (medium)
- `oauth-client-credentials` (medium)
- `adaptive-response-notable` (hard)

## What's next

Expand toward a minimum of 30 community-contributed tasks, and add an `expected/` +
`grade.ts` per-task grader for finer-grained scoring beyond syntax/build/appinspect.
