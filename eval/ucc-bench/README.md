# UCC-bench

A tiny, community-extensible evaluation harness for the Splunk UCC agent.

Each task lives in its own directory under `tasks/` and contains:

- `task.md` — the human/user prompt the agent receives.
- `expected/` — files that must be produced. Directory layout mirrors the VFS (`package/...`).
- `grade.ts` — optional TypeScript grader. If present, it receives the generated
  VFS snapshot and returns a `{ passed: boolean; reasons: string[] }`.
- `metadata.json` — `{ "difficulty": "easy|medium|hard", "tags": [...] }`.

The runner in `runner.ts` executes a task against the configured model profile
and compares the output to `expected/`.

## Running

```bash
# Default: run all tasks once with the current MODEL_PROFILE.
npx tsx eval/ucc-bench/runner.ts

# Run a single task:
npx tsx eval/ucc-bench/runner.ts --task simple-rest-poll

# JSON output for CI:
npx tsx eval/ucc-bench/runner.ts --json > results.json
```

## v0 scope

Current baseline includes five tasks:

- `simple-rest-poll`
- `alert-action-webhook`
- `custom-command-enrich`
- `oauth-client-credentials`
- `adaptive-response-notable`

Next milestone is to wire full model execution + grading against generated
artifacts, then expand toward a minimum of 30 community-contributed tasks.
