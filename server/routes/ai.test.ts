// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// setupTests.ts stubs global.fetch to avoid accidental network calls. This route
// test needs REAL HTTP to drive the SSE endpoint over the loopback, so we issue
// the request with node's http module (which the stub does not touch) and
// collect the full SSE body once the response ends.
function httpPost(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: chunks }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpPostFull(
  url: string,
  body: unknown,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: chunks,
            contentType: String(res.headers['content-type'] || ''),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' },
      (res) => {
        let chunks = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: chunks }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Proves routes/ai.ts delegates the agent loop to the SHARED core
 * (server/services/agentRunner.ts) — the SAME loop the eval bench drives — and
 * only translates the runner's events into SSE frames + persists session state.
 *
 * We mock `runAgent` so we don't hit OpenRouter; the mock both emits the runner's
 * transport-agnostic events AND mutates the passed VFS, exactly as the real loop
 * does, so we can assert the route streams every frame and the final files.
 */

import type { AgentRunOptions, AgentEvent } from '../services/agentRunner.js';

const runAgentMock = vi.fn<[AgentRunOptions], Promise<unknown>>();

vi.mock('../services/agentRunner.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, runAgent: (opts: AgentRunOptions) => runAgentMock(opts) };
});

let server: Server;
let baseUrl = '';

beforeEach(async () => {
  runAgentMock.mockReset();
  process.env.OPENROUTER_API_KEY = 'test-key';
  const { aiRouter } = await import('./ai.js');
  const app = express();
  app.use(express.json());
  app.use('/api', aiRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  delete process.env.OPENROUTER_API_KEY;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('POST /api/ai/agent/stream', () => {
  it('drives the shared agentRunner and translates its events into SSE frames', async () => {
    // The mock plays the role of the real shared loop: emit the runner's events
    // (planner → iteration → tool_call → tool_result → assistant_delta) and write
    // a file into the VFS the route handed us.
    runAgentMock.mockImplementation(async (opts: AgentRunOptions) => {
      const emit = (e: AgentEvent) => opts.onEvent?.(e);
      emit({ type: 'planner', content: '1. plan' });
      emit({ type: 'iteration', index: 1 });
      emit({ type: 'tool_call', id: 't1', name: 'todo_write', arguments: '{}' });
      emit({ type: 'tool_result', id: 't1', name: 'todo_write', content: 'Todo list updated (1 items).' });
      emit({ type: 'tool_call', id: 't2', name: 'write_file', arguments: '{}' });
      emit({ type: 'tool_result', id: 't2', name: 'write_file', content: 'ok' });
      opts.vfs.writeFile('package/default/app.conf', '[install]\n', 'user');
      emit({ type: 'assistant_delta', content: 'done' });
      return { iterations: 1, finalContent: 'done', hitIterationLimit: false, plannerText: '1. plan' };
    });

    const res = await httpPost(`${baseUrl}/api/ai/agent/stream`, {
      sessionId: 's1',
      system: 'sys',
      messages: [{ role: 'user', content: 'build it' }],
      files: [],
    });

    expect(res.status).toBe(200);
    const body = res.body;

    // The route passed the canonical SERVER_TOOLS + the request's system/messages
    // straight into the shared runner.
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const passed = runAgentMock.mock.calls[0][0];
    expect(passed.systemPrompt).toBe('sys');
    expect(passed.messages).toEqual([{ role: 'user', content: 'build it' }]);
    // The server loop runs the SAME canonical primitives as the browser registry
    // (single source of truth: src/lib/ai/coreTools.ts) plus its privileged
    // integration tools.
    const { CORE_AGENT_TOOLS } = await import('../../src/lib/ai/coreTools.js');
    const passedNames = new Set(passed.tools.map((t) => t.name));
    for (const core of CORE_AGENT_TOOLS) {
      expect(passedNames.has(core.name)).toBe(true);
    }
    expect(passedNames.has('build_and_inspect')).toBe(true);
    // The live-Splunk grounding tools are now ALWAYS in the toolset (gated by the
    // approval POLICY — default `ask` — rather than excluded). AGENT_MCP_GROUNDING
    // now controls ask-vs-auto, not presence.
    expect(passedNames.has('get_live_indexes')).toBe(true);

    // Every runner event was translated into an SSE frame.
    expect(body).toContain('event: planner');
    expect(body).toContain('event: iteration');
    expect(body).toContain('event: tool_call');
    expect(body).toContain('event: tool_result');
    expect(body).toContain('event: assistant_delta');
    // A todo_write tool result triggers a todos frame.
    expect(body).toContain('event: todos');
    // Terminal frames + the VFS the runner mutated is streamed back.
    expect(body).toContain('event: files');
    expect(body).toContain('package/default/app.conf');
    expect(body).toContain('event: done');
  });

  it('returns 403 when no API key is configured', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const res = await httpPost(`${baseUrl}/api/ai/agent/stream`, { messages: [] });
    expect(res.status).toBe(403);
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('ALWAYS includes the live-Splunk grounding tools (gated by policy, regardless of AGENT_MCP_GROUNDING)', async () => {
    const prev = process.env.AGENT_MCP_GROUNDING;
    delete process.env.AGENT_MCP_GROUNDING;
    runAgentMock.mockResolvedValue({
      iterations: 0,
      finalContent: '',
      hitIterationLimit: false,
      stoppedNoProgress: false,
      plannerText: '',
    });
    try {
      await httpPost(`${baseUrl}/api/ai/agent/stream`, {
        sessionId: 's-grounding',
        system: 'sys',
        messages: [{ role: 'user', content: 'use my real indexes' }],
        files: [],
      });
      const passed = runAgentMock.mock.calls[runAgentMock.mock.calls.length - 1][0];
      const names = new Set(passed.tools.map((t: { name: string }) => t.name));
      expect(names.has('get_live_indexes')).toBe(true);
      expect(names.has('run_splunk_query')).toBe(true);
      expect(names.has('build_and_inspect')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AGENT_MCP_GROUNDING;
      else process.env.AGENT_MCP_GROUNDING = prev;
    }
  });
});

describe('Tool-approval policy in /api/ai/config', () => {
  it('exposes the effective policy map + askTools list', async () => {
    const prev = process.env.AGENT_MCP_GROUNDING;
    try {
      delete process.env.AGENT_MCP_GROUNDING;
      const res = await httpGet(`${baseUrl}/api/ai/config`);
      const body = JSON.parse(res.body);
      expect(body.toolPolicy).toBeTruthy();
      // External-access tools default to ask; local tools to auto.
      expect(body.toolPolicy.policy.run_splunk_query).toBe('ask');
      expect(body.toolPolicy.policy.write_file).toBe('auto');
      expect(body.toolPolicy.policy.build_and_inspect).toBe('auto');
      expect(body.toolPolicy.askTools).toContain('run_splunk_query');
      expect(body.toolPolicy.mcpGroundingAuto).toBe(false);

      // With grounding ON the grounding tools become auto (seamless).
      process.env.AGENT_MCP_GROUNDING = '1';
      const on = JSON.parse((await httpGet(`${baseUrl}/api/ai/config`)).body);
      expect(on.toolPolicy.policy.run_splunk_query).toBe('auto');
      expect(on.toolPolicy.mcpGroundingAuto).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AGENT_MCP_GROUNDING;
      else process.env.AGENT_MCP_GROUNDING = prev;
    }
  });
});

describe('POST /api/ai/agent/approve', () => {
  it('validates the body', async () => {
    const noId = await httpPost(`${baseUrl}/api/ai/agent/approve`, { decision: 'approve' });
    expect(noId.status).toBe(400);
    const badDecision = await httpPost(`${baseUrl}/api/ai/agent/approve`, { approvalId: 'x', decision: 'maybe' });
    expect(badDecision.status).toBe(400);
  });

  it('returns 404 for an unknown approvalId', async () => {
    const res = await httpPost(`${baseUrl}/api/ai/agent/approve`, { approvalId: 'nope', decision: 'approve' });
    expect(res.status).toBe(404);
  });

  it('resolves a pending approval raised by the stream gate (approve_session → remembered)', async () => {
    delete process.env.AGENT_MCP_GROUNDING; // run_splunk_query defaults to ask
    const { sessionApprovals } = await import('../services/toolPolicy.js');
    sessionApprovals.clearSession('s-approve');

    // The mocked runAgent invokes the gate for an `ask` tool. The first call should
    // pause: it emits approval_request and AWAITs. We POST approve_session to
    // resolve it, then a SECOND gate call for the same tool must run automatically.
    let firstOutcome: { action: string } | null = null;
    let secondOutcome: { action: string } | null = null;

    runAgentMock.mockImplementation(async (opts: AgentRunOptions) => {
      const gate = opts.approvalGate!;
      // Kick off the first (pausing) gate call.
      const p1 = gate({ tool: 'run_splunk_query', args: { query: 'x' }, rawArgs: '{}', id: 'c1' });
      // Give the route a tick to emit approval_request + register the promise.
      await new Promise((r) => setTimeout(r, 30));
      const { approvalRegistry } = await import('../services/approvalRegistry.js');
      expect(approvalRegistry.size).toBe(1);
      // Resolve via the REAL HTTP endpoint (the browser's path) using the pending id.
      const id = approvalRegistry.pendingIds()[0];
      const approveRes = await httpPost(`${baseUrl}/api/ai/agent/approve`, {
        approvalId: id,
        decision: 'approve_session',
      });
      expect(approveRes.status).toBe(200);
      firstOutcome = await p1;
      // Second call for the same tool in the same session → auto (remembered).
      secondOutcome = await gate({ tool: 'run_splunk_query', args: { query: 'y' }, rawArgs: '{}', id: 'c2' });
      return { iterations: 1, finalContent: '', hitIterationLimit: false, plannerText: '' };
    });

    const res = await httpPost(`${baseUrl}/api/ai/agent/stream`, {
      sessionId: 's-approve',
      system: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      files: [],
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('event: approval_request');
    expect(firstOutcome).toEqual({ action: 'run' });
    expect(secondOutcome).toEqual({ action: 'run' });
    expect(sessionApprovals.isApproved('s-approve', 'run_splunk_query')).toBe(true);
  });

  it('deny policy refuses outright with an adapt message and never prompts', async () => {
    let outcome: { action: string; message?: string } | null = null;
    runAgentMock.mockImplementation(async (opts: AgentRunOptions) => {
      outcome = await opts.approvalGate!({ tool: 'run_splunk_query', args: {}, rawArgs: '{}', id: 'c1' });
      return { iterations: 1, finalContent: '', hitIterationLimit: false, plannerText: '' };
    });
    const res = await httpPost(`${baseUrl}/api/ai/agent/stream`, {
      sessionId: 's-deny',
      system: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      files: [],
      toolPolicy: { run_splunk_query: 'deny' },
    });
    expect(res.status).toBe(200);
    // No prompt was raised.
    expect(res.body).not.toContain('event: approval_request');
    expect(outcome!.action).toBe('skip');
    expect(outcome!.message).toMatch(/denied by policy/i);
  });

  it('auto policy (override) runs an external tool with no prompt', async () => {
    let outcome: { action: string } | null = null;
    runAgentMock.mockImplementation(async (opts: AgentRunOptions) => {
      outcome = await opts.approvalGate!({ tool: 'run_splunk_query', args: {}, rawArgs: '{}', id: 'c1' });
      return { iterations: 1, finalContent: '', hitIterationLimit: false, plannerText: '' };
    });
    const res = await httpPost(`${baseUrl}/api/ai/agent/stream`, {
      sessionId: 's-auto',
      system: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      files: [],
      toolPolicy: { run_splunk_query: 'auto' },
    });
    expect(res.body).not.toContain('event: approval_request');
    expect(outcome!.action).toBe('run');
  });
});

describe('GET /api/ai/config — MCP grounding flag', () => {
  it('reports mcpGroundingEnabled=false by default and true when the flag is set', async () => {
    const prev = process.env.AGENT_MCP_GROUNDING;
    try {
      delete process.env.AGENT_MCP_GROUNDING;
      const off = await httpGet(`${baseUrl}/api/ai/config`);
      expect(off.status).toBe(200);
      expect(JSON.parse(off.body).capabilities.mcpGroundingEnabled).toBe(false);

      process.env.AGENT_MCP_GROUNDING = 'true';
      const on = await httpGet(`${baseUrl}/api/ai/config`);
      expect(JSON.parse(on.body).capabilities.mcpGroundingEnabled).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AGENT_MCP_GROUNDING;
      else process.env.AGENT_MCP_GROUNDING = prev;
    }
  });
});

describe('POST /api/ai/chat — streaming pass-through', () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('pipes OpenRouter SSE straight through when stream:true (so the embedded client-side agent loop gets per-turn frames behind the buffering Splunk proxy)', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    globalThis.fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const f of frames) controller.enqueue(enc.encode(f));
          controller.close();
        },
      });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: stream,
        json: async () => ({}),
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const res = await httpPostFull(`${baseUrl}/api/ai/chat`, {
      model: 'x',
      messages: [],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/event-stream');
    expect(res.body).toContain('"content":"hel"');
    expect(res.body).toContain('[DONE]');
  });

  it('returns a single JSON completion when stream is not requested', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
    } as unknown as Response)) as unknown as typeof globalThis.fetch;

    const res = await httpPostFull(`${baseUrl}/api/ai/chat`, { model: 'x', messages: [] });

    expect(res.status).toBe(200);
    expect(res.contentType).toContain('application/json');
    expect(JSON.parse(res.body).choices[0].message.content).toBe('hi');
  });
});
