#!/usr/bin/env tsx
/**
 * UCC-bench runner (v0).
 *
 * Runs each task under `tasks/` against the configured agent and grades the
 * output. v0 is intentionally small — it exists to prove the shape. Real
 * model execution will be wired in alongside the server-side agent loop.
 *
 * Usage:
 *   npx tsx eval/ucc-bench/runner.ts           # run all
 *   npx tsx eval/ucc-bench/runner.ts --task X  # run one
 *   npx tsx eval/ucc-bench/runner.ts --json    # machine-readable output
 */

import fs from 'fs/promises';
import path from 'path';
import { resolveModelProfile } from '../../src/lib/ai/modelProfile';

interface TaskResult {
  task: string;
  passed: boolean;
  reasons: string[];
  durationMs: number;
}

interface BenchResult {
  profile: string;
  models: Record<string, string>;
  tasks: TaskResult[];
  passRate: number;
  timestamp: string;
}

const TASKS_DIR = path.join(new URL('.', import.meta.url).pathname, 'tasks');

async function listTasks(): Promise<string[]> {
  const entries = await fs.readdir(TASKS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function runTask(name: string): Promise<TaskResult> {
  const start = Date.now();
  const taskDir = path.join(TASKS_DIR, name);
  const reasons: string[] = [];

  try {
    const taskMd = await fs.readFile(path.join(taskDir, 'task.md'), 'utf-8');
    if (!taskMd.trim()) reasons.push('task.md is empty');
  } catch {
    reasons.push('missing task.md');
  }

  try {
    const meta = JSON.parse(
      await fs.readFile(path.join(taskDir, 'metadata.json'), 'utf-8'),
    );
    if (!meta.difficulty) reasons.push('metadata.difficulty missing');
  } catch {
    reasons.push('missing or invalid metadata.json');
  }

  // Stub: v0 only validates the task definition; the agent-run path lands with
  // the server-side loop (see ROADMAP.md Phase 2).
  const passed = reasons.length === 0;
  return {
    task: name,
    passed,
    reasons: passed ? ['task definition valid (v0 stub — model run not yet wired)'] : reasons,
    durationMs: Date.now() - start,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const taskFilter = args[args.indexOf('--task') + 1];
  const asJson = args.includes('--json');

  const profile = resolveModelProfile();
  const names = taskFilter ? [taskFilter] : await listTasks();
  const results: TaskResult[] = [];
  for (const n of names) {
    const r = await runTask(n);
    results.push(r);
  }
  const passed = results.filter((r) => r.passed).length;
  const out: BenchResult = {
    profile: profile.name,
    models: profile.models,
    tasks: results,
    passRate: results.length ? passed / results.length : 0,
    timestamp: new Date().toISOString(),
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  console.log(`UCC-bench — profile=${out.profile}`);
  console.log(`Models: ${JSON.stringify(out.models)}`);
  console.log('');
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.task}  (${r.durationMs}ms)`);
    for (const reason of r.reasons) console.log(`       ${reason}`);
  }
  console.log('');
  console.log(`Pass rate: ${(out.passRate * 100).toFixed(1)}% (${passed}/${results.length})`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
