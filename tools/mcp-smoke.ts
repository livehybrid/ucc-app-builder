#!/usr/bin/env tsx
/**
 * Hermetic MCP-server JSON-RPC smoke test.
 *
 * Spawns `server/mcp/server.ts` over stdio and drives a real JSON-RPC session:
 *   initialize -> tools/list -> create_addon -> add_input -> list_project
 *
 * It asserts the protocol handshake works, all 5 builder tools are advertised,
 * and the in-memory project mutates correctly. It deliberately does NOT call
 * validate_app/package_app (those run ucc-gen + appinspect — covered by the loop
 * smoke), so this stays fast and needs no Splunk toolchain.
 *
 * Exit 0 on success, non-zero on any failed assertion. Used by CI.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const serverPath = path.join(repoRoot, 'server', 'mcp', 'server.ts');

interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function main() {
  const child = spawn('npx', ['tsx', serverPath], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: process.env,
  });

  const pending = new Map<number, (r: RpcResponse) => void>();
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: RpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const cb = pending.get(msg.id);
      if (cb) {
        pending.delete(msg.id);
        cb(msg);
      }
    }
  });

  let nextId = 1;
  const rpc = (method: string, params: unknown): Promise<RpcResponse> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 30_000);
    });

  const textOf = (res: RpcResponse): string => {
    const r = res.result as { content?: Array<{ text?: string }> } | undefined;
    return r?.content?.map((c) => c.text ?? '').join('\n') ?? '';
  };

  try {
    // 1. initialize
    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-smoke', version: '0.0.0' },
    });
    if (init.error) fail(`initialize errored: ${init.error.message}`);
    const serverInfo = (init.result as { serverInfo?: { name?: string } })?.serverInfo;
    if (serverInfo?.name !== 'ucc-app-builder') fail(`unexpected server name: ${serverInfo?.name}`);
    console.log(`✅ initialize -> ${serverInfo?.name}`);

    // 2. tools/list
    const tools = await rpc('tools/list', {});
    const names = ((tools.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name);
    const expected = ['create_addon', 'add_input', 'validate_app', 'package_app', 'list_project'];
    for (const e of expected) if (!names.includes(e)) fail(`tools/list missing ${e} (got ${names.join(', ')})`);
    console.log(`✅ tools/list -> ${names.length} tools: ${names.join(', ')}`);

    // 3. create_addon
    const created = await rpc('tools/call', {
      name: 'create_addon',
      arguments: { name: 'github_audit', displayName: 'GitHub Audit', version: '1.0.0' },
    });
    if (created.error) fail(`create_addon errored: ${created.error.message}`);
    if (!/TA_github_audit/.test(textOf(created))) fail(`create_addon did not report appId: ${textOf(created)}`);
    console.log('✅ create_addon -> TA_github_audit');

    // 4. add_input
    const added = await rpc('tools/call', {
      name: 'add_input',
      arguments: { name: 'github_repos', title: 'GitHub Repos' },
    });
    if (added.error) fail(`add_input errored: ${added.error.message}`);
    if (!/Added input "github_repos"/.test(textOf(added))) fail(`add_input unexpected: ${textOf(added)}`);
    console.log('✅ add_input -> github_repos');

    // 5. list_project — must reflect the generated files including the input.
    const listed = await rpc('tools/call', {
      name: 'list_project',
      arguments: {},
    });
    const listText = textOf(listed);
    if (!/globalConfig\.json/.test(listText)) fail(`list_project missing globalConfig.json: ${listText}`);
    if (!/github_repos\.py/.test(listText)) fail(`list_project missing input script: ${listText}`);
    console.log('✅ list_project -> project contains globalConfig.json + github_repos.py');

    console.log('\n🎉 MCP JSON-RPC smoke PASSED');
    child.kill();
    process.exit(0);
  } catch (e) {
    child.kill();
    fail((e as Error).message);
  }
}

main();
