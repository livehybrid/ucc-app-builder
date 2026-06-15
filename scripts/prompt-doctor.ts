#!/usr/bin/env tsx
/**
 * prompt-doctor — admin tool to improve the agent system prompt from real traces.
 *
 * This is an ADMIN task that runs OUTSIDE the app UI. It iterates the JSONL
 * traces the agent has written, finds recurring gaps, and (optionally) asks an
 * LLM to propose minimal edits to the system prompt — which are applied ONLY
 * after you review a diff and confirm.
 *
 *   npx tsx scripts/prompt-doctor.ts                  # analyse traces, print the gap report (FREE, no LLM)
 *   npx tsx scripts/prompt-doctor.ts --json           # gap report as JSON
 *   npx tsx scripts/prompt-doctor.ts --suggest        # + ask the LLM for prompt edits (costs a little); writes a proposal file
 *   npx tsx scripts/prompt-doctor.ts --apply <file>   # review a proposal's diff and, on y/N consent, write the new prompt
 *
 * Flags: --traces <dir> (default .ucc-agent/traces) · --model <id> · --limit <n>
 *
 * Safety: --apply NEVER writes without an interactive "yes". It backs up the
 * current prompt to <file>.bak first, and refuses if the on-disk prompt no
 * longer matches the proposal's baseline (someone edited it meanwhile).
 */
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  parseTraceJsonl,
  summarizeSession,
  buildGapReport,
  GapReport,
} from '../server/services/traceAnalysis.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Load the same env the server uses (project .env first, then the AIOS root) so
// --suggest finds OPENROUTER_API_KEY without the operator exporting it by hand.
dotenv.config({ path: path.join(ROOT, '.env') });
dotenv.config({ path: path.join(ROOT, '..', '..', '.env') });
// The prompt is plain markdown (systemPrompt.md), imported into systemPrompt.ts
// as a raw string. Editing the .md means no template-literal escaping to worry about.
const PROMPT_FILE = path.join(ROOT, 'src/lib/ai/systemPrompt.md');
const PROPOSALS_DIR = path.join(ROOT, '.ucc-agent/prompt-proposals');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(name);

async function loadSessions(dir: string, limit: number) {
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    console.error(`No trace dir at ${dir}. Run the agent first, or pass --traces <dir>.`);
    process.exit(1);
  }
  // Newest first by mtime.
  const stated = await Promise.all(
    files.map(async (f) => ({ f, m: (await fs.stat(path.join(dir, f))).mtimeMs }))
  );
  stated.sort((a, b) => b.m - a.m);
  const chosen = stated.slice(0, limit).map((s) => s.f);
  const summaries = [];
  for (const f of chosen) {
    const events = parseTraceJsonl(await fs.readFile(path.join(dir, f), 'utf-8'));
    summaries.push(summarizeSession(f.replace(/\.jsonl$/, ''), events));
  }
  return summaries;
}

function printReport(report: GapReport) {
  console.log(
    `\nAnalysed ${report.sessionsAnalyzed} session(s) — chat:${report.byFamily.chat} loop:${report.byFamily.loop} other:${report.byFamily.unknown}\n`
  );
  if (report.findings.length === 0) {
    console.log('No recurring gaps detected. 🎉');
    return;
  }
  const icon = { high: '🔴', medium: '🟡', low: '⚪' };
  const tag = { prompt: 'PROMPT', code: 'CODE ', infra: 'INFRA' };
  for (const f of report.findings) {
    console.log(`${icon[f.severity]} [${tag[f.category]}] ${f.title}  (×${f.count})`);
    console.log(`    ${f.detail}`);
    if (f.promptSuggestion) console.log(`    → prompt fix: ${f.promptSuggestion}`);
    console.log('');
  }
  const promptable = report.findings.filter((f) => f.category === 'prompt');
  console.log(
    promptable.length
      ? `${promptable.length} prompt-addressable finding(s). Run with --suggest to get proposed prompt edits.`
      : 'No prompt-addressable findings — the gaps are code/infra (fix those in source).'
  );
}

async function suggest(report: GapReport, modelId: string) {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_APIKEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY not set — cannot run --suggest. (Analysis above is free.)');
    process.exit(1);
  }
  const promptable = report.findings.filter((f) => f.category === 'prompt' && f.promptSuggestion);
  if (promptable.length === 0) {
    console.log('Nothing prompt-addressable to suggest — gaps are code/infra.');
    return;
  }
  const currentBody = await fs.readFile(PROMPT_FILE, 'utf-8');

  const gaps = promptable
    .map(
      (f) =>
        `- ${f.title} (seen in ${f.count} run(s)): ${f.detail}\n  Suggested direction: ${f.promptSuggestion}`
    )
    .join('\n');

  const system =
    'You improve an AI agent system prompt using evidence from production traces. ' +
    'Make the SMALLEST set of additive, surgical edits that address the listed gaps. ' +
    'Preserve the existing structure, headings, and all existing rules. Do not delete content ' +
    'unless it directly contradicts a fix. Return ONLY JSON: ' +
    '{"revisedPrompt":"<full new prompt text>","changes":[{"summary":"...","rationale":"..."}]}';
  const user = `## Recurring prompt-addressable gaps from traces\n${gaps}\n\n## Current system prompt\n<<<PROMPT\n${currentBody}\nPROMPT`;

  console.error(`Asking ${modelId} for prompt edits addressing ${promptable.length} gap(s)…`);
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Title': 'UCCBuilder-PromptDoctor',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp.ok) {
    console.error(`LLM error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content ?? '{}';
  let parsed: { revisedPrompt?: string; changes?: Array<{ summary: string; rationale: string }> };
  try {
    parsed = JSON.parse(content);
  } catch {
    const mm = content.match(/\{[\s\S]*\}/);
    parsed = mm ? JSON.parse(mm[0]) : {};
  }
  if (!parsed.revisedPrompt) {
    console.error('LLM returned no revisedPrompt. Raw:', content.slice(0, 300));
    process.exit(1);
  }

  await fs.mkdir(PROPOSALS_DIR, { recursive: true });
  const out = path.join(PROPOSALS_DIR, `proposal-${Date.now()}.json`);
  await fs.writeFile(
    out,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        model: modelId,
        baselineBody: currentBody,
        revisedPrompt: parsed.revisedPrompt,
        changes: parsed.changes ?? [],
        addressed: promptable.map((f) => f.id),
      },
      null,
      2
    )
  );
  console.log('\nProposed changes:');
  for (const c of parsed.changes ?? []) console.log(`  • ${c.summary}\n      ${c.rationale}`);
  printUnifiedDiff(currentBody, parsed.revisedPrompt);
  console.log(`\nProposal saved: ${path.relative(ROOT, out)}`);
  console.log(
    `Review it, then apply with:\n  npx tsx scripts/prompt-doctor.ts --apply ${path.relative(ROOT, out)}`
  );
}

function printUnifiedDiff(before: string, after: string) {
  const a = before.split('\n');
  const b = after.split('\n');
  const setB = new Set(b);
  const setA = new Set(a);
  console.log('\n--- diff (line-level) ---');
  let shown = 0;
  for (const line of a) if (!setB.has(line) && shown++ < 40) console.log(`- ${line}`);
  shown = 0;
  for (const line of b) if (!setA.has(line) && shown++ < 40) console.log(`+ ${line}`);
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => rl.question(question, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function apply(proposalPath: string) {
  const proposal = JSON.parse(await fs.readFile(proposalPath, 'utf-8')) as {
    baselineBody: string;
    revisedPrompt: string;
    changes?: Array<{ summary: string }>;
  };
  const currentBody = await fs.readFile(PROMPT_FILE, 'utf-8');

  if (currentBody !== proposal.baselineBody) {
    console.error(
      'REFUSING: the live prompt no longer matches the proposal baseline (it was edited since the proposal was generated). Re-run --suggest.'
    );
    process.exit(1);
  }

  console.log('Changes to apply:');
  for (const c of proposal.changes ?? []) console.log(`  • ${c.summary}`);
  printUnifiedDiff(currentBody, proposal.revisedPrompt);

  if (!(await confirm('\nApply these changes to src/lib/ai/systemPrompt.md? [y/N] '))) {
    console.log('Aborted. Nothing written.');
    return;
  }
  await fs.writeFile(`${PROMPT_FILE}.bak`, currentBody);
  await fs.writeFile(
    PROMPT_FILE,
    proposal.revisedPrompt.endsWith('\n') ? proposal.revisedPrompt : `${proposal.revisedPrompt}\n`
  );
  console.log(`Wrote ${path.relative(ROOT, PROMPT_FILE)} (backup at systemPrompt.md.bak).`);
  console.log(
    'Next: run `npm run lint && npx vitest run` and review `git diff` before committing.'
  );
}

async function main() {
  const dir = path.resolve(arg('--traces', '.ucc-agent/traces')!);
  const limit = Number(arg('--limit', '200'));
  const model = arg('--model', process.env.PROMPT_DOCTOR_MODEL || 'anthropic/claude-sonnet-4.6')!;

  const applyFile = arg('--apply');
  if (applyFile) {
    await apply(path.resolve(applyFile));
    return;
  }

  const summaries = await loadSessions(dir, limit);
  const report = buildGapReport(summaries);

  if (has('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
  if (has('--suggest')) await suggest(report, model);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
