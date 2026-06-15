#!/usr/bin/env tsx
/**
 * Records a full MCP-server JSON-RPC session to stdout (for transcripts/).
 * Drives: initialize -> tools/list -> create_addon -> add_input -> package_app.
 * package_app runs the real agentic loop (ucc-gen + splunk-appinspect), so this
 * takes a few minutes. Each request and response is printed.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const serverPath = path.join(repoRoot, 'server', 'mcp', 'server.ts');

interface Rpc {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

async function main() {
  const child = spawn('npx', ['tsx', serverPath], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, UCC_FIXER_MODEL: process.env.UCC_FIXER_MODEL ?? '' },
  });

  const pending = new Map<number, (r: Rpc) => void>();
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg: Rpc = JSON.parse(line);
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      } catch {
        /* ignore non-JSON */
      }
    }
  });

  let nextId = 1;
  const rpc = (method: string, params: unknown): Promise<Rpc> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const req = { jsonrpc: '2.0' as const, id, method, params };
      console.log(`\n>>> REQUEST  ${method}\n${JSON.stringify(req, null, 2)}`);
      pending.set(id, (r) => {
        console.log(`<<< RESPONSE ${method}\n${JSON.stringify(r, null, 2)}`);
        resolve(r);
      });
      child.stdin.write(JSON.stringify(req) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 600_000);
    });

  console.log('=== UCC App Builder — MCP server JSON-RPC session ===');
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-record', version: '0.0.0' },
  });
  await rpc('tools/list', {});
  await rpc('tools/call', {
    name: 'create_addon',
    arguments: { name: 'github_audit', displayName: 'GitHub Audit', version: '1.0.0' },
  });
  await rpc('tools/call', {
    name: 'add_input',
    arguments: {
      name: 'github_repos',
      title: 'GitHub Repos',
      fields: [{ field: 'api_token', label: 'API Token', type: 'password', required: true }],
    },
  });
  await rpc('tools/call', { name: 'package_app', arguments: { useLlm: false } });

  console.log('\n=== session complete ===');
  child.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('record failed:', e);
  process.exit(1);
});
