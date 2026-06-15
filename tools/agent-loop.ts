#!/usr/bin/env tsx
/**
 * CLI demo of the keystone agentic loop:
 *   generate (ucc-gen) -> splunk-appinspect -> auto-fix -> repeat until clean.
 *
 * Usage:
 *   npx tsx tools/agent-loop.ts                 # runs the bundled demo add-on
 *   npx tsx tools/agent-loop.ts <project.json>  # { appId, version?, files: [{path,content}] }
 *   npx tsx tools/agent-loop.ts --no-llm        # deterministic fixers only (no OpenRouter call)
 *
 * Reads OPENROUTER_API_KEY from the environment (or ../../.env) for the LLM fixer.
 *
 * This is intentionally self-contained: it produces a *deliberately imperfect*
 * add-on (check_for_updates = true) so the loop has something real to fix, then
 * shows AppInspect going green.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { runAgentLoop, LoopEvent, LoopFile } from '../server/services/agentLoop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
loadEnv({ path: path.join(repoRoot, '.env') });
loadEnv({ path: path.resolve(repoRoot, '..', '..', '.env') });

const APP_ID = 'TA_demo_forge';

/** A minimal-but-real UCC add-on, deliberately tripping check_for_updates_disabled. */
function demoProject(): { appId: string; version: string; files: LoopFile[] } {
  const globalConfig = {
    meta: {
      name: APP_ID,
      restRoot: APP_ID,
      version: '1.0.0',
      displayName: 'Demo Forge',
      schemaVersion: '0.0.9',
    },
    pages: {
      configuration: {
        title: 'Configuration',
        description: 'Set up your add-on',
        tabs: [
          {
            name: 'logging',
            title: 'Logging',
            entity: [
              {
                type: 'singleSelect',
                label: 'Log level',
                field: 'loglevel',
                options: { items: [{ value: 'INFO', label: 'INFO' }, { value: 'DEBUG', label: 'DEBUG' }] },
                defaultValue: 'INFO',
              },
            ],
          },
        ],
      },
      inputs: {
        title: 'Inputs',
        description: 'Manage inputs',
        table: { header: [{ label: 'Name', field: 'name' }], actions: ['edit', 'delete', 'clone'] },
        services: [
          {
            name: 'demo_input',
            title: 'Demo Input',
            entity: [
              { type: 'text', label: 'Name', field: 'name', required: true },
              { type: 'text', label: 'Interval', field: 'interval', required: true, defaultValue: '300' },
              { type: 'text', label: 'Index', field: 'index', required: true, defaultValue: 'default' },
            ],
          },
        ],
      },
    },
  };

  const appConf = `[install]
is_configured = 0

[package]
id = ${APP_ID}
check_for_updates = true

[launcher]
author = livehybrid
description = Demo add-on built by the agentic loop
version = 1.0.0

[ui]
is_visible = 1
label = Demo Forge
`;

  const manifest = {
    schemaVersion: '2.0.0',
    info: {
      title: 'Demo Forge',
      id: { group: null, name: APP_ID, version: '1.0.0' },
      author: [{ name: 'livehybrid', email: '' }],
      description: 'Demo add-on built by the agentic loop',
      license: { name: 'Apache-2.0', uri: 'https://www.apache.org/licenses/LICENSE-2.0' },
    },
    supportedDeployments: ['_standalone', '_distributed', '_search_head_clustering'],
    targetWorkloads: ['_search_heads'],
  };

  return {
    appId: APP_ID,
    version: '1.0.0',
    files: [
      { path: `${APP_ID}/globalConfig.json`, content: JSON.stringify(globalConfig, null, 2) },
      { path: `${APP_ID}/package/app.manifest`, content: JSON.stringify(manifest, null, 2) },
      { path: `${APP_ID}/package/default/app.conf`, content: appConf },
    ],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const noLlm = args.includes('--no-llm');
  const llmOnly = args.includes('--llm-only');
  const fileArg = args.find((a) => !a.startsWith('--'));

  let project: { appId: string; version?: string; files: LoopFile[] };
  if (fileArg) {
    project = JSON.parse(fs.readFileSync(fileArg, 'utf-8'));
  } else {
    project = demoProject();
  }

  const icon = (k: string) =>
    ({
      start: '🟢', iteration: '🔁', build: '🔨', build_error: '💥', package: '📦',
      inspect: '🔎', fix: '🩹', fix_skipped: '⚠️', clean: '✅', exhausted: '🛑', done: '🏁',
    } as Record<string, string>)[k] ?? '•';

  console.log(`\n=== UCC App Builder — Agentic AppInspect Loop ===`);
  console.log(`app: ${project.appId}  llm: ${!noLlm}\n`);

  const result = await runAgentLoop({
    sessionId: `cli-${Date.now()}`,
    appId: project.appId,
    version: project.version,
    files: project.files,
    includeWarnings: true,
    useLlm: !noLlm,
    llmOnly,
    onEvent: (e: LoopEvent) => {
      console.log(`${icon(e.kind)} [it${e.iteration}] ${e.message}`);
    },
  });

  console.log(`\n--- Final AppInspect summary ---`);
  console.log(result.finalSummary ?? '(none)');
  console.log(`\nResult: ${result.clean ? '✅ CLEAN' : '❌ NOT CLEAN'} after ${result.iterations} iteration(s).`);
  if (result.tarball) console.log(`Package: ${result.tarball}`);
  process.exit(result.clean ? 0 : 1);
}

main().catch((e) => {
  console.error('Loop failed:', e);
  process.exit(2);
});
