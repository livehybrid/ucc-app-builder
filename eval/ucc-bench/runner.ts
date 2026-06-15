#!/usr/bin/env tsx
/**
 * UCC-bench runner.
 *
 * Runs each task under `tasks/` END-TO-END against the SAME tool-calling agent
 * the UI uses (server/routes/ai.ts exports SERVER_TOOLS; the loop lives in
 * server/services/agentRunner.ts), then grades the agent's output on three axes:
 *
 *   syntax     — every package/bin/*.py compiles under python3.
 *   build      — `ucc-gen build` + package succeeds.
 *   appinspect — Splunk AppInspect reports no failures (warnings tolerated).
 *
 * The build + appinspect grades reuse the production self-correcting loop
 * (server/services/agentLoop.ts) so the bench measures exactly what we ship.
 *
 * Usage:
 *   npx tsx eval/ucc-bench/runner.ts                 # run all (needs OPENROUTER_API_KEY)
 *   npx tsx eval/ucc-bench/runner.ts --task simple-rest-poll
 *   npx tsx eval/ucc-bench/runner.ts --dry-run       # validate task defs only (no API, CI-safe)
 *   npx tsx eval/ucc-bench/runner.ts --json          # machine-readable
 *   npx tsx eval/ucc-bench/runner.ts --max-iterations 16
 *
 * Results transcripts are written to results/<timestamp>.json (+ latest.json).
 */

import fs from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

import { resolveModelProfile } from '../../src/lib/ai/modelProfile.js';
import { VirtualFileSystem } from '../../src/lib/vfs.js';
import { generateSplunkApp } from '../../src/lib/generator.js';
import { DEFAULT_COMPONENTS_CONFIG } from '../../src/types/components.js';
import type { AppMetadata } from '../../src/types/app.js';
import { runAgent, type AgentEvent } from '../../server/services/agentRunner.js';
import { SERVER_TOOLS } from '../../server/routes/ai.js';
import { runAgentLoop } from '../../server/services/agentLoop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
loadEnv({ path: path.join(repoRoot, '.env') });
loadEnv({ path: path.resolve(repoRoot, '..', '..', '.env') });

const TASKS_DIR = path.join(__dirname, 'tasks');
const RESULTS_DIR = path.join(__dirname, 'results');

interface Grades {
  syntax: boolean;
  build: boolean;
  appinspect: boolean;
}

interface TaskResult {
  task: string;
  appId: string;
  passed: boolean;
  grades: Grades;
  reasons: string[];
  loopIterations?: number;
  agentIterations?: number;
  finalSummary?: string;
  toolCalls?: string[];
  finalFiles?: string[];
  buildLog?: string[];
  agentBuildInspect?: string;
  durationMs: number;
}

interface BenchResult {
  mode: 'full' | 'dry-run';
  profile: string;
  models: Record<string, string>;
  tasks: TaskResult[];
  passRate: number;
  scores: { syntax: number; build: number; appinspect: number };
  timestamp: string;
}

function openRouterApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_APIKEY;
}

async function listTasks(): Promise<string[]> {
  const entries = await fs.readdir(TASKS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function parseAppId(taskMd: string, fallback: string): string {
  const m = taskMd.match(/App id:\s*`?([A-Za-z0-9_]+)`?/i);
  return m ? m[1] : fallback;
}

function baselineMetadata(appId: string): AppMetadata {
  return {
    name: appId,
    displayName: appId,
    description: `${appId} — UCC-bench task`,
    author: 'ucc-bench',
    email: '',
    version: '1.0.0',
    appId,
    licenseName: 'Apache-2.0',
    licenseUri: 'https://www.apache.org/licenses/LICENSE-2.0',
  };
}

/**
 * Seed a fresh boilerplate add-on into the VFS (the agent's starting point).
 *
 * The generator nests every file under `<appId>/`. The agent loop (toWorkPath)
 * and the agent's own write habits both treat `package/` / `globalConfig.json`
 * as the app ROOT. We normalise the seed to that root layout so the agent's
 * edits and the build see one consistent tree (avoids a split-root build break).
 */
function seedBoilerplate(appId: string): VirtualFileSystem {
  const gen = new VirtualFileSystem();
  generateSplunkApp(gen, {
    metadata: baselineMetadata(appId),
    branding: { navBarColor: '#65A637', logoFile: null },
    components: JSON.parse(JSON.stringify(DEFAULT_COMPONENTS_CONFIG)),
  });
  const vfs = new VirtualFileSystem();
  const prefix = `${appId}/`;
  for (const f of gen.getAllFiles()) {
    const rel = f.path.replace(/^\/+/, '');
    const stripped = rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
    vfs.writeFile(stripped, f.content, 'generated');
  }
  return vfs;
}

function benchSystemPrompt(appId: string): string {
  return `You are the Splunk UCC App Builder agent. You build AppInspect-clean Splunk
add-ons using the UCC framework by editing files in the workspace with your tools.

The workspace ALREADY contains a boilerplate add-on. ALL of its files live under
the app root "${appId}/". The two paths you will edit most are:
  - ${appId}/globalConfig.json   (UI/config + input definitions)
  - ${appId}/package/bin/<name>.py  (Python modular inputs / commands / alert actions)
CRITICAL: every file you create or edit MUST be under "${appId}/" (e.g.
"${appId}/package/bin/posts_input.py"). Do NOT write to a bare "package/..." path —
that creates a second, broken app root and the build will fail.

CORRECT UCC BUILD ORDER: globalConfig.json is the CORE artifact — ucc-gen generates
almost everything else from it. (1) author ${appId}/globalConfig.json from the request;
(2) ensure ${appId}/package/app.manifest exists (REQUIRED — ucc-gen does NOT generate it);
(3) do NOT hand-write default/app.conf, inputs.conf or other default/*.conf — ucc-gen
REGENERATES those from globalConfig, so editing them is futile; (4) call build_and_inspect
to generate the boilerplate; (5) THEN implement the request logic in package/bin/.

Work EFFICIENTLY: call list_files ONCE, read ${appId}/globalConfig.json ONCE, then
edit. Do not re-list or re-read files you have already seen — you have a limited
number of turns and must reach build_and_inspect. Make the changes the task requires:
- Edit ${appId}/globalConfig.json for input/config definitions (use write_file / apply_patch).
- Write Python modular inputs under ${appId}/package/bin/ using the splunklib UCC SDK.
- Never hard-code secrets; mark password/API-key fields as encrypted.

globalConfig.json rules (UCC schema — get these right or the build fails):
- There is exactly ONE globalConfig.json, at "${appId}/globalConfig.json". NEVER create
  "${appId}/package/globalConfig.json" — that path is invalid and breaks the build.
- The "inputs" page MUST include a "table" object listing the columns to show, e.g.
  "table": { "header": [ {"label":"Name","field":"name"}, {"label":"Status","field":"disabled"} ] }.
  Every field referenced in table.header MUST be a declared entity on the service
  (the "name" entity is always required; "disabled" is injected by UCC).
- Each input service needs an "entity" array (at least a "name" text field).

INPUT HANDLERS ARE MANDATORY: for EVERY input service "<name>" you declare in
globalConfig.json pages.inputs.services, you MUST also write the modular-input
handler script at "${appId}/package/bin/<name>.py". ucc-gen will happily build and
AppInspect will pass even when this script is missing (UCC generates only the
wrapper) — but the add-on is INCOMPLETE without it and the task is NOT done.
The handler must:
  - start with "import import_declare_test" (UCC library-path shim),
  - subclass splunklib's modular-input Script (or the UCC BaseModInput), and
  - implement the collection logic (e.g. get_scheme + stream_events, with clear
    error logging). Use generate_input_script for a correct skeleton, then adapt.
Write the handler for each declared input BEFORE you call build_and_inspect.

Live-Splunk MCP grounding is OFF by default — a standard build is STANDALONE. Use the
grounding tools (get_live_indexes / get_splunk_metadata) ONLY if they are present in your
toolset AND the task explicitly needs the live environment. Otherwise proceed from your own
knowledge — do not block on grounding.

CRITICAL: when you have finished editing, you MUST call build_and_inspect. It runs
ucc-gen build + AppInspect and auto-corrects known findings. If it reports NOT
clean OR INCOMPLETE (a declared input missing its handler), fix the gap with
generate_input_script / write_file / apply_patch and call it again. Do not stop
until build_and_inspect reports AppInspect-CLEAN with no missing handlers.`;
}

/** Python syntax check: every package/bin/*.py must parse under python3. */
function gradeSyntax(vfs: VirtualFileSystem): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const pyFiles = vfs.getAllFiles().filter((f) => /package\/bin\/.*\.py$/.test(f.path));
  if (pyFiles.length === 0) {
    return { ok: false, reasons: ['no package/bin/*.py produced'] };
  }
  for (const f of pyFiles) {
    // Compile from stdin: python3 - <<< source. ast.parse catches syntax errors
    // without importing (so missing Splunk libs don't cause false negatives).
    const check = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
      input: f.content,
      encoding: 'utf-8',
    });
    if (check.status !== 0) {
      const last = String(check.stderr).trim().split('\n').pop() ?? 'syntax error';
      reasons.push(`${f.path}: ${last}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

async function runOne(name: string, maxIterations: number, dryRun: boolean): Promise<TaskResult> {
  const start = Date.now();
  const taskDir = path.join(TASKS_DIR, name);
  const reasons: string[] = [];

  let taskMd = '';
  try {
    taskMd = await fs.readFile(path.join(taskDir, 'task.md'), 'utf-8');
    if (!taskMd.trim()) reasons.push('task.md is empty');
  } catch {
    reasons.push('missing task.md');
  }
  try {
    const meta = JSON.parse(await fs.readFile(path.join(taskDir, 'metadata.json'), 'utf-8'));
    if (!meta.difficulty) reasons.push('metadata.difficulty missing');
  } catch {
    reasons.push('missing or invalid metadata.json');
  }

  const appId = parseAppId(taskMd, name.replace(/[^a-z0-9]/gi, '_'));

  if (dryRun) {
    const passed = reasons.length === 0;
    return {
      task: name,
      appId,
      passed,
      grades: { syntax: false, build: false, appinspect: false },
      reasons: passed ? ['task definition valid (dry-run: agent not executed)'] : reasons,
      durationMs: Date.now() - start,
    };
  }

  if (reasons.length) {
    return { task: name, appId, passed: false, grades: { syntax: false, build: false, appinspect: false }, reasons, durationMs: Date.now() - start };
  }

  const apiKey = openRouterApiKey();
  if (!apiKey) {
    return { task: name, appId, passed: false, grades: { syntax: false, build: false, appinspect: false }, reasons: ['OPENROUTER_API_KEY not set — cannot run agent (use --dry-run for definition checks)'], durationMs: Date.now() - start };
  }

  const profile = resolveModelProfile();
  const vfs = seedBoilerplate(appId);
  const toolCalls: string[] = [];
  let lastBuildInspect = '';

  // 1. Run the agent end-to-end against the seeded boilerplate.
  let agentIterations = 0;
  try {
    const res = await runAgent({
      apiKey,
      tools: SERVER_TOOLS,
      systemPrompt: benchSystemPrompt(appId),
      messages: [{ role: 'user', content: taskMd }],
      vfs,
      plannerModel: profile.models.planner,
      executorModel: profile.models.executor,
      maxIterations,
      onEvent: (e: AgentEvent) => {
        if (e.type === 'tool_call') toolCalls.push(e.name);
        if (e.type === 'tool_result' && e.name === 'build_and_inspect') lastBuildInspect = e.content;
      },
    });
    agentIterations = res.iterations;
  } catch (e) {
    return { task: name, appId, passed: false, grades: { syntax: false, build: false, appinspect: false }, reasons: [`agent run failed: ${(e as Error).message}`], toolCalls, durationMs: Date.now() - start };
  }

  // 2. Grade syntax on the agent's final VFS.
  const syntax = gradeSyntax(vfs);

  // 3. Grade build + appinspect via the production loop (independent of whether
  //    the agent already called build_and_inspect — this is the authoritative score).
  let build = false;
  let appinspect = false;
  let loopIterations: number | undefined;
  let finalSummary: string | undefined;
  const loopReasons: string[] = [];
  const buildLog: string[] = [];
  try {
    const loop = await runAgentLoop({
      sessionId: `bench-${name}-${Date.now()}`,
      appId,
      version: '1.0.0',
      files: vfs.getAllFiles().map((f) => ({ path: f.path, content: f.content })),
      // Allow the deterministic fixers a few iterations (build-error pins, app.conf
      // knobs, forbidden static files) — these are free + reliable and mirror what
      // the agent's own build_and_inspect does. useLlm:false keeps grading
      // deterministic: the LLM never gets a second bite at the model's output here.
      maxIterations: 4,
      includeWarnings: false,
      useLlm: false,
      onEvent: (e) => {
        if (e.kind === 'build_error' || e.kind === 'build' || e.kind === 'inspect') {
          buildLog.push(`[${e.kind}] ${e.message}`);
          const logs = (e.data?.logs as string[] | undefined) ?? [];
          for (const l of logs) buildLog.push(`    ${l}`);
        }
      },
    });
    loopIterations = loop.iterations;
    finalSummary = loop.finalSummary;
    build = !!loop.tarball;
    appinspect = loop.clean;
    if (!build) loopReasons.push('ucc-gen build failed');
    else if (!appinspect) loopReasons.push(`AppInspect not clean: ${loop.finalSummary?.split('\n')[0] ?? 'failures present'}`);
  } catch (e) {
    loopReasons.push(`grading loop failed: ${(e as Error).message}`);
  }

  const grades: Grades = { syntax: syntax.ok, build, appinspect };
  const allReasons = [...syntax.reasons, ...loopReasons];
  const passed = grades.syntax && grades.build && grades.appinspect;
  return {
    task: name,
    appId,
    passed,
    grades,
    reasons: passed ? ['syntax + build + appinspect all clean'] : allReasons,
    loopIterations,
    agentIterations,
    finalSummary,
    toolCalls,
    finalFiles: vfs.getAllFiles().map((f) => f.path),
    buildLog: buildLog.slice(-25),
    agentBuildInspect: lastBuildInspect ? lastBuildInspect.slice(0, 1200) : undefined,
    durationMs: Date.now() - start,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const taskFilter = args.includes('--task') ? args[args.indexOf('--task') + 1] : undefined;
  const asJson = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const maxIterations = args.includes('--max-iterations')
    ? Number(args[args.indexOf('--max-iterations') + 1])
    : 14;

  const profile = resolveModelProfile();
  const names = taskFilter ? [taskFilter] : await listTasks();
  const results: TaskResult[] = [];
  for (const n of names) {
    if (!asJson) process.stderr.write(`▶ ${n} ...\n`);
    results.push(await runOne(n, maxIterations, dryRun));
  }

  const passed = results.filter((r) => r.passed).length;
  const score = (key: keyof Grades) => results.filter((r) => r.grades[key]).length / (results.length || 1);
  const out: BenchResult = {
    mode: dryRun ? 'dry-run' : 'full',
    profile: profile.name,
    models: profile.models,
    tasks: results,
    passRate: results.length ? passed / results.length : 0,
    scores: { syntax: score('syntax'), build: score('build'), appinspect: score('appinspect') },
    timestamp: new Date().toISOString(),
  };

  // Persist a transcript (skip for single-task dry-runs to avoid noise).
  if (!dryRun || !taskFilter) {
    await fs.mkdir(RESULTS_DIR, { recursive: true });
    const stamp = out.timestamp.replace(/[:.]/g, '-');
    const file = path.join(RESULTS_DIR, `${out.mode}-${stamp}.json`);
    await fs.writeFile(file, JSON.stringify(out, null, 2) + '\n');
    await fs.writeFile(path.join(RESULTS_DIR, `latest-${out.mode}.json`), JSON.stringify(out, null, 2) + '\n');
    if (!asJson) process.stderr.write(`\nTranscript: ${path.relative(repoRoot, file)}\n`);
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(passed === results.length ? 0 : 1);
  }

  console.log(`\nUCC-bench (${out.mode}) — profile=${out.profile}`);
  console.log(`Models: ${JSON.stringify(out.models)}\n`);
  for (const r of results) {
    const g = dryRun ? '' : `  [syntax:${r.grades.syntax ? '✓' : '✗'} build:${r.grades.build ? '✓' : '✗'} appinspect:${r.grades.appinspect ? '✓' : '✗'}]`;
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.task}${g}  (${(r.durationMs / 1000).toFixed(1)}s)`);
    for (const reason of r.reasons) console.log(`       ${reason}`);
  }
  if (!dryRun) {
    console.log(`\nScores — syntax ${(out.scores.syntax * 100).toFixed(0)}%  build ${(out.scores.build * 100).toFixed(0)}%  appinspect ${(out.scores.appinspect * 100).toFixed(0)}%`);
  }
  console.log(`Pass rate: ${(out.passRate * 100).toFixed(1)}% (${passed}/${results.length})`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
