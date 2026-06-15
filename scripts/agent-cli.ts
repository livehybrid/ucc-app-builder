#!/usr/bin/env tsx
/**
 * agent-cli — run the UCC App Builder agent from the command line.
 *
 * Same planner/executor loop, tools, and system prompt as the in-app chat
 * (server/services/agentRunner.ts + the SERVER_TOOLS gate), driven headlessly so
 * you can test prompt changes quickly and programmatically (pairs with
 * scripts/prompt-doctor.ts). Tools auto-run (no approval gate).
 *
 *   npx tsx scripts/agent-cli.ts "Add a modular input that polls a REST API"
 *   npx tsx scripts/agent-cli.ts --prompt "…" --model anthropic/claude-sonnet-4.6 --max-iters 8
 *   npx tsx scripts/agent-cli.ts --seed ./some-app-dir "Make it AppInspect-clean"   # seed the VFS from a dir
 *   npx tsx scripts/agent-cli.ts --out ./agent-out "…"   # write the resulting VFS files to a dir
 *   npx tsx scripts/agent-cli.ts --json "…"              # machine-readable result on stdout
 *
 * Env (auto-loaded from project .env then the AIOS root .env): OPENROUTER_API_KEY.
 * The system prompt is read from src/lib/ai/systemPrompt.md (the same file the UI
 * uses and prompt-doctor edits), so a prompt change is reflected immediately.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { runAgent, resolveMaxIterations, AgentEvent } from '../server/services/agentRunner.js';
import { resolveServerTools } from '../server/routes/ai.js';
import { resolveModelProfile } from '../src/lib/ai/modelProfile.js';
import { VirtualFileSystem } from '../src/lib/vfs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
dotenv.config({ path: path.join(ROOT, '..', '..', '.env') });
const PROMPT_FILE = path.join(ROOT, 'src/lib/ai/systemPrompt.md');

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

/**
 * Free-text prompt: --prompt-file <path> (keeps secrets off the command line),
 * else --prompt value, else the first non-flag argument.
 */
async function getPrompt(): Promise<string> {
  const file = flag('--prompt-file');
  if (file) return (await fs.readFile(path.resolve(file), 'utf-8')).trim();
  const explicit = flag('--prompt');
  if (explicit) return explicit;
  const args = process.argv.slice(2);
  const flagsWithValue = new Set([
    '--prompt',
    '--prompt-file',
    '--model',
    '--max-iters',
    '--seed',
    '--out',
  ]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flagsWithValue.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith('--')) return a;
  }
  return '';
}

async function seedVfs(vfs: VirtualFileSystem, dir: string) {
  async function walk(d: string) {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(dir, full);
        vfs.writeFile(rel, await fs.readFile(full, 'utf-8'), 'user');
      }
    }
  }
  await walk(dir);
}

async function main() {
  const prompt = await getPrompt();
  if (!prompt) {
    console.error('Usage: npx tsx scripts/agent-cli.ts "<your request>" [--prompt-file f] [--model id] [--max-iters n] [--seed dir] [--out dir] [--json]');
    process.exit(1);
  }
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_APIKEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY not set (looked in project .env and the AIOS root .env).');
    process.exit(1);
  }

  const profile = resolveModelProfile();
  const executorModel = flag('--model') || profile.models.executor;
  const plannerModel = flag('--model') || profile.models.planner || executorModel;
  const maxIterations = resolveMaxIterations(
    flag('--max-iters') ? Number(flag('--max-iters')) : undefined
  );
  const systemPrompt = await fs.readFile(PROMPT_FILE, 'utf-8');

  const vfs = new VirtualFileSystem();
  const seedDir = flag('--seed');
  if (seedDir) {
    await seedVfs(vfs, path.resolve(seedDir));
    process.stderr.write(`Seeded VFS with ${vfs.getAllFiles().length} file(s) from ${seedDir}\n`);
  }

  const jsonOut = has('--json');
  const log = (s: string) => process.stderr.write(s + '\n');
  log(`▶ model=${executorModel} maxIters=${maxIterations}\n› ${prompt}\n`);

  const onEvent = (e: AgentEvent) => {
    if (jsonOut) return; // keep stdout clean for the JSON result
    switch (e.type) {
      case 'planner':
        log(`\n📋 plan:\n${e.content}\n`);
        break;
      case 'iteration':
        log(`\n── iteration ${e.index} ──`);
        break;
      case 'assistant_delta':
        process.stderr.write(e.content);
        break;
      case 'tool_call':
        log(`\n🔧 ${e.name}(${e.arguments.slice(0, 200)})`);
        break;
      case 'tool_result':
        log(`   ↳ ${e.content.slice(0, 300).replace(/\n/g, ' ')}`);
        break;
      case 'warning':
        log(`\n⚠️  ${e.message}`);
        break;
      case 'no_progress':
        log(`\n🛑 no progress: ${e.message}`);
        break;
      case 'usage':
        log(`\n📊 tokens — in ${e.promptTokens} / out ${e.completionTokens} / total ${e.totalTokens}`);
        break;
      case 'error':
        log(`\n❌ ${e.error}`);
        break;
    }
  };

  const result = await runAgent({
    apiKey,
    tools: resolveServerTools(),
    systemPrompt,
    messages: [{ role: 'user', content: prompt }],
    vfs,
    plannerModel,
    executorModel,
    maxIterations,
    onEvent,
    // No approvalGate → tools auto-run (headless).
  });

  const outDir = flag('--out');
  if (outDir) {
    for (const f of vfs.getAllFiles()) {
      const dest = path.join(path.resolve(outDir), f.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.content);
    }
    log(`\n💾 wrote ${vfs.getAllFiles().length} file(s) to ${outDir}`);
  }

  if (jsonOut) {
    process.stdout.write(
      JSON.stringify(
        {
          prompt,
          model: executorModel,
          iterations: result.iterations,
          hitIterationLimit: result.hitIterationLimit,
          stoppedNoProgress: result.stoppedNoProgress,
          usage: result.usage,
          finalContent: result.finalContent,
          files: vfs.getAllFiles().map((f) => f.path),
        },
        null,
        2
      ) + '\n'
    );
  } else {
    log(`\n${'='.repeat(60)}`);
    log(`✅ done — ${result.iterations} iteration(s)${result.hitIterationLimit ? ' (hit cap)' : ''}${result.stoppedNoProgress ? ' (no-progress stop)' : ''}`);
    log(`📊 tokens — in ${result.usage.promptTokens} / out ${result.usage.completionTokens} / total ${result.usage.totalTokens}`);
    log(`📁 VFS files: ${vfs.getAllFiles().length}`);
    log(`\n${result.finalContent}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
