import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VirtualFileSystem } from '../../src/lib/vfs.js';
import {
  runAgent,
  resolveMaxIterations,
  resolveNoProgressLimit,
  resolveLlmConnectTimeout,
  resolveLlmStallTimeout,
  readOpenRouterStream,
  LlmTimeoutError,
  ToolCallAccumulator,
  type AgentRunnerTool,
  type AgentEvent,
} from './agentRunner.js';

/**
 * The runner talks to OpenRouter over fetch + SSE. We stub fetch to return
 * canned SSE streams so we can drive the planner/executor loop deterministically.
 */

function sseStream(chunks: string[]): globalThis.Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** One SSE line carrying an assistant content delta. */
const contentChunk = (s: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n\n`;

/** A complete tool call delivered in one chunk. */
const toolCallChunk = (id: string, name: string, args: string) =>
  `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }],
  })}\n\n`;

const echoTool: AgentRunnerTool = {
  name: 'echo',
  description: 'echo',
  parameters: { type: 'object', properties: { msg: { type: 'string' } } },
  execute: async (args, vfs) => {
    vfs.writeFile('package/touched.txt', String(args.msg ?? ''), 'user');
    return `echoed: ${args.msg}`;
  },
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runAgent', () => {
  it('runs a tool call then finishes, writing to the VFS and emitting events', async () => {
    // 1) planner (non-stream JSON) -> 2) executor turn 1 (tool call) ->
    // 3) executor turn 2 (final content, no tools).
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '1. do it' } }] }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(sseStream([toolCallChunk('call_1', 'echo', '{"msg":"hi"}')]))
      .mockResolvedValueOnce(sseStream([contentChunk('all done')]));

    const vfs = new VirtualFileSystem();
    const events: AgentEvent[] = [];
    const res = await runAgent({
      apiKey: 'k',
      tools: [echoTool],
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'please echo hi' }],
      vfs,
      plannerModel: 'p',
      executorModel: 'e',
      maxIterations: 5,
      onEvent: (e) => events.push(e),
    });

    expect(res.iterations).toBe(2);
    expect(res.finalContent).toBe('all done');
    expect(res.plannerText).toContain('do it');
    expect(vfs.readFile('package/touched.txt')).toBe('hi');

    const types = events.map((e) => e.type);
    expect(types).toContain('planner');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult && 'content' in toolResult && toolResult.content).toContain('echoed: hi');
  });

  it('folds the planner output into a SINGLE system message (Anthropic rejects two)', async () => {
    // Regression: a second `system` message at messages[1] makes Anthropic (and the
    // Bedrock/Vertex proxies behind OpenRouter) 400 with "role 'system' must follow
    // a 'user' message ...". The planner guidance must be folded into the one system
    // message instead.
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '1. inspect 2. fix' } }] }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(sseStream([contentChunk('done')]));

    await runAgent({
      apiKey: 'k',
      tools: [echoTool],
      systemPrompt: 'BASE_SYSTEM',
      messages: [{ role: 'user', content: 'continue' }],
      vfs: new VirtualFileSystem(),
      plannerModel: 'p',
      executorModel: 'e',
      maxIterations: 5,
    });

    // The executor call is the 2nd fetch (1st is the planner).
    const executorInit = fetchMock.mock.calls[1][1] as { body: string };
    const sentMessages = JSON.parse(executorInit.body).messages as Array<{
      role: string;
      content: string;
    }>;
    const systemMessages = sentMessages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(sentMessages[0].role).toBe('system');
    expect(sentMessages[1].role).toBe('user'); // no second system before the user turn
    // Planner guidance is folded into the single system message.
    expect(systemMessages[0].content).toContain('BASE_SYSTEM');
    expect(systemMessages[0].content).toContain('inspect 2. fix');
  });

  it('accumulates token usage from the stream usage chunk', async () => {
    const usageChunk =
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } })}\n\n`;
    fetchMock.mockResolvedValueOnce(sseStream([contentChunk('done'), usageChunk]));

    const events: AgentEvent[] = [];
    const res = await runAgent({
      apiKey: 'k',
      tools: [echoTool],
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      vfs: new VirtualFileSystem(),
      plannerModel: 'p',
      executorModel: 'e',
      maxIterations: 5,
      skipPlanner: true,
      onEvent: (e) => events.push(e),
    });

    expect(res.usage).toEqual({ promptTokens: 120, completionTokens: 30, totalTokens: 150 });
    const usageEvent = events.find((e) => e.type === 'usage');
    expect(usageEvent).toMatchObject({ promptTokens: 120, completionTokens: 30, totalTokens: 150 });
    // It requested usage from the provider.
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('skips the planner turn when skipPlanner is set', async () => {
    fetchMock.mockResolvedValueOnce(sseStream([contentChunk('no plan needed')]));
    const res = await runAgent({
      apiKey: 'k',
      tools: [],
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      vfs: new VirtualFileSystem(),
      plannerModel: 'p',
      executorModel: 'e',
      skipPlanner: true,
    });
    // Only one fetch (executor); no planner call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.plannerText).toBe('');
    expect(res.finalContent).toBe('no plan needed');
  });

  it('reports unknown tools without crashing the loop', async () => {
    fetchMock
      .mockResolvedValueOnce(sseStream([toolCallChunk('c1', 'does_not_exist', '{}')]))
      .mockResolvedValueOnce(sseStream([contentChunk('handled')]));
    const events: AgentEvent[] = [];
    const res = await runAgent({
      apiKey: 'k',
      tools: [echoTool],
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      vfs: new VirtualFileSystem(),
      plannerModel: 'p',
      executorModel: 'e',
      skipPlanner: true,
      onEvent: (e) => events.push(e),
    });
    const tr = events.find((e) => e.type === 'tool_result');
    expect(tr && 'content' in tr && tr.content).toMatch(/not available/i);
    expect(res.finalContent).toBe('handled');
  });

  it('stops at maxIterations and warns when the model keeps making (genuine) progress', async () => {
    // Every executor turn returns a tool call with DIFFERENT args → genuine
    // progress (distinct results), so the no-progress breaker must NOT fire; the
    // loop only ends because it hits the iteration cap.
    let n = 0;
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      void init;
      n += 1;
      return sseStream([toolCallChunk('c', 'echo', `{"msg":"x${n}"}`)]);
    });
    const events: AgentEvent[] = [];
    const res = await runAgent({
      apiKey: 'k',
      tools: [echoTool],
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'loop' }],
      vfs: new VirtualFileSystem(),
      plannerModel: 'p',
      executorModel: 'e',
      maxIterations: 3,
      skipPlanner: true,
      onEvent: (e) => events.push(e),
    });
    expect(res.iterations).toBe(3);
    expect(res.hitIterationLimit).toBe(true);
    expect(res.stoppedNoProgress).toBe(false);
    expect(events.some((e) => e.type === 'no_progress')).toBe(false);
    expect(events.some((e) => e.type === 'warning')).toBe(true);
  });

  it('approvalGate=run lets the tool execute as normal', async () => {
    fetchMock
      .mockResolvedValueOnce(sseStream([toolCallChunk('c1', 'echo', '{"msg":"go"}')]))
      .mockResolvedValueOnce(sseStream([contentChunk('ok')]));
    const vfs = new VirtualFileSystem();
    const gate = vi.fn().mockResolvedValue({ action: 'run' });
    await runAgent({
      apiKey: 'k',
      tools: [echoTool],
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      vfs,
      plannerModel: 'p',
      executorModel: 'e',
      skipPlanner: true,
      approvalGate: gate,
    });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate.mock.calls[0][0]).toMatchObject({ tool: 'echo', args: { msg: 'go' } });
    expect(vfs.readFile('package/touched.txt')).toBe('go'); // tool ran
  });

  it('approvalGate=skip refuses the tool and feeds the message back to the agent', async () => {
    fetchMock
      .mockResolvedValueOnce(sseStream([toolCallChunk('c1', 'echo', '{"msg":"go"}')]))
      .mockResolvedValueOnce(sseStream([contentChunk('adapted')]));
    const vfs = new VirtualFileSystem();
    const events: AgentEvent[] = [];
    const gate = vi
      .fn()
      .mockResolvedValue({ action: 'skip', message: 'User declined "echo". Proceed without it.' });
    const res = await runAgent({
      apiKey: 'k',
      tools: [echoTool],
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      vfs,
      plannerModel: 'p',
      executorModel: 'e',
      skipPlanner: true,
      approvalGate: gate,
      onEvent: (e) => events.push(e),
    });
    // The tool did NOT run (no VFS write), and the skip message was surfaced as the
    // tool result the agent sees.
    expect(vfs.readFile('package/touched.txt')).toBeNull();
    const tr = events.find((e) => e.type === 'tool_result');
    expect(tr && 'content' in tr && tr.content).toBe('User declined "echo". Proceed without it.');
    expect(res.finalContent).toBe('adapted');
  });

  it('a throwing approvalGate is treated as skip (fail-safe)', async () => {
    fetchMock
      .mockResolvedValueOnce(sseStream([toolCallChunk('c1', 'echo', '{"msg":"go"}')]))
      .mockResolvedValueOnce(sseStream([contentChunk('done')]));
    const vfs = new VirtualFileSystem();
    const events: AgentEvent[] = [];
    await runAgent({
      apiKey: 'k',
      tools: [echoTool],
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      vfs,
      plannerModel: 'p',
      executorModel: 'e',
      skipPlanner: true,
      approvalGate: vi.fn().mockRejectedValue(new Error('registry exploded')),
      onEvent: (e) => events.push(e),
    });
    expect(vfs.readFile('package/touched.txt')).toBeNull();
    const tr = events.find((e) => e.type === 'tool_result');
    expect(tr && 'content' in tr && tr.content).toMatch(/Approval for echo failed/i);
  });

  it('no-progress breaker: stops early when the same failing tool repeats', async () => {
    // A tool that always throws → identical error every time.
    const failTool: AgentRunnerTool = {
      name: 'flaky',
      description: 'always fails',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('boom');
      },
    };
    fetchMock.mockImplementation(async () => sseStream([toolCallChunk('c', 'flaky', '{}')]));
    const events: AgentEvent[] = [];
    const res = await runAgent({
      apiKey: 'k',
      tools: [failTool],
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      vfs: new VirtualFileSystem(),
      plannerModel: 'p',
      executorModel: 'e',
      maxIterations: 20, // high cap — the breaker, not the cap, must stop us
      noProgressLimit: 3,
      skipPlanner: true,
      onEvent: (e) => events.push(e),
    });
    expect(res.stoppedNoProgress).toBe(true);
    expect(res.hitIterationLimit).toBe(false);
    expect(res.iterations).toBe(3); // broke at the 3rd identical failure
    const np = events.find((e) => e.type === 'no_progress');
    expect(np).toBeTruthy();
    if (np && np.type === 'no_progress') {
      expect(np.tool).toBe('flaky');
      expect(np.message).toMatch(/no progress/i);
      expect(np.lastError).toMatch(/boom/i);
    }
  });

  it('no-progress breaker: stops early when the same tool returns an identical result', async () => {
    // A tool that always returns the SAME (non-error) string → no progress.
    const constTool: AgentRunnerTool = {
      name: 'constant',
      description: 'same every time',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'identical output',
    };
    fetchMock.mockImplementation(async () => sseStream([toolCallChunk('c', 'constant', '{}')]));
    const res = await runAgent({
      apiKey: 'k',
      tools: [constTool],
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      vfs: new VirtualFileSystem(),
      plannerModel: 'p',
      executorModel: 'e',
      maxIterations: 20,
      noProgressLimit: 2,
      skipPlanner: true,
    });
    expect(res.stoppedNoProgress).toBe(true);
    expect(res.iterations).toBe(2);
  });

  it('no-progress breaker: a Security Error for the same path breaks immediately on the second hit', async () => {
    const secTool: AgentRunnerTool = {
      name: 'write_file',
      description: 'write',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      execute: async () => 'Security Error: path outside sandbox',
    };
    fetchMock.mockImplementation(async () =>
      sseStream([toolCallChunk('c', 'write_file', '{"path":"/etc/passwd"}')])
    );
    const events: AgentEvent[] = [];
    const res = await runAgent({
      apiKey: 'k',
      tools: [secTool],
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      vfs: new VirtualFileSystem(),
      plannerModel: 'p',
      executorModel: 'e',
      maxIterations: 20,
      noProgressLimit: 5, // would NOT trip at 2 — the security-path rule must
      skipPlanner: true,
      onEvent: (e) => events.push(e),
    });
    expect(res.stoppedNoProgress).toBe(true);
    expect(res.iterations).toBe(2); // broke on the SECOND security refusal
    const np = events.find((e) => e.type === 'no_progress');
    expect(np && np.type === 'no_progress' && np.message).toMatch(/security error/i);
  });

  it('does NOT break when the agent makes progress (alternating distinct results)', async () => {
    // Tool returns a different result each call → never trips the breaker; the
    // loop ends naturally when the model stops calling tools.
    let n = 0;
    const progressTool: AgentRunnerTool = {
      name: 'step',
      description: 'progress',
      parameters: { type: 'object', properties: {} },
      execute: async () => `result-${n}`,
    };
    fetchMock.mockImplementation(async () => {
      n += 1;
      if (n <= 4) return sseStream([toolCallChunk('c', 'step', `{"i":${n}}`)]);
      return sseStream([contentChunk('done')]);
    });
    const res = await runAgent({
      apiKey: 'k',
      tools: [progressTool],
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      vfs: new VirtualFileSystem(),
      plannerModel: 'p',
      executorModel: 'e',
      maxIterations: 20,
      noProgressLimit: 3,
      skipPlanner: true,
    });
    expect(res.stoppedNoProgress).toBe(false);
    expect(res.finalContent).toBe('done');
  });
});

describe('resolveMaxIterations / resolveNoProgressLimit (env-var defaults)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('uses the explicit value (clamped) over the env var', () => {
    process.env.AGENT_MAX_ITERATIONS = '5';
    expect(resolveMaxIterations(8)).toBe(8);
    expect(resolveMaxIterations(99)).toBe(20); // clamped to max
    expect(resolveMaxIterations(0)).toBe(1); // clamped to min
  });

  it('falls back to AGENT_MAX_ITERATIONS when no explicit value', () => {
    process.env.AGENT_MAX_ITERATIONS = '7';
    expect(resolveMaxIterations()).toBe(7);
    process.env.AGENT_MAX_ITERATIONS = '50';
    expect(resolveMaxIterations()).toBe(20); // env value clamped too
  });

  it('falls back to 12 when neither explicit nor env is set', () => {
    delete process.env.AGENT_MAX_ITERATIONS;
    expect(resolveMaxIterations()).toBe(12);
  });

  it('resolveNoProgressLimit prefers explicit, then env, then 3 (min 2)', () => {
    delete process.env.AGENT_NO_PROGRESS_LIMIT;
    expect(resolveNoProgressLimit()).toBe(3);
    expect(resolveNoProgressLimit(5)).toBe(5);
    expect(resolveNoProgressLimit(1)).toBe(2); // floor of 2
    process.env.AGENT_NO_PROGRESS_LIMIT = '4';
    expect(resolveNoProgressLimit()).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// ToolCallAccumulator — streamed tool-call chunk assembly
// ---------------------------------------------------------------------------

describe('ToolCallAccumulator', () => {
  it('assembles OpenAI-spec indexed parallel calls into separate entries', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: 'a', function: { name: 'read_file', arguments: '{"path":' } });
    acc.add({ index: 1, id: 'b', function: { name: 'list_files', arguments: '{}' } });
    acc.add({ index: 0, function: { arguments: '"x.txt"}' } });
    const calls = acc.finalize();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      id: 'a',
      function: { name: 'read_file', arguments: '{"path":"x.txt"}' },
    });
    expect(calls[1]).toEqual({ id: 'b', function: { name: 'list_files', arguments: '{}' } });
  });

  it('splits when a provider reuses index 0 with a NEW id (Kimi-style)', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: 'a', function: { name: 'write_file', arguments: '{"path":"a.txt"}' } });
    acc.add({ index: 0, id: 'b', function: { name: 'write_file', arguments: '{"path":"b.txt"}' } });
    const calls = acc.finalize();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].function.arguments).path).toBe('a.txt');
    expect(JSON.parse(calls[1].function.arguments).path).toBe('b.txt');
  });

  it('splits on a complete-JSON boundary even without a new id, inheriting the name', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: 'a', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } });
    acc.add({ index: 0, function: { arguments: '{"path":"b.txt"}' } });
    const calls = acc.finalize();
    expect(calls).toHaveLength(2);
    expect(calls[1].function.name).toBe('read_file'); // inherited
    expect(JSON.parse(calls[1].function.arguments).path).toBe('b.txt');
    expect(calls[1].id).toBe('call_1'); // fallback id
  });

  it('does NOT split when a `{` chunk continues incomplete JSON (brace inside content)', () => {
    const acc = new ToolCallAccumulator();
    acc.add({
      index: 0,
      id: 'a',
      function: { name: 'write_file', arguments: '{"path":"x.json","content":"' },
    });
    acc.add({ index: 0, function: { arguments: '{\\"a\\":1}"}' } });
    const calls = acc.finalize();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].function.arguments).content).toBe('{"a":1}');
  });

  it('handles index-less continuation chunks as one call', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ id: 'a', function: { name: 'read_file', arguments: '{"path":' } });
    acc.add({ function: { arguments: '"y.txt"}' } });
    const calls = acc.finalize();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].function.arguments).path).toBe('y.txt');
  });
});

// ---------------------------------------------------------------------------
// Breaker coverage for invalid-args / unknown-tool outcomes
// ---------------------------------------------------------------------------

describe('runAgent breaker gaps', () => {
  it('stops after repeated unparsable tool arguments instead of burning iterations', async () => {
    // Three consecutive turns each emitting one write_file call with corrupted
    // (concatenated) JSON args. Previously these bypassed the breaker entirely.
    const badArgs = '{"path":"a"}{"path":"b"}';
    fetchMock
      .mockResolvedValueOnce(
        sseStream([toolCallChunk('c1', 'echo', badArgs.replace('{"path":"b"}', '{"x":1}{"y":2}'))])
      )
      .mockResolvedValueOnce(sseStream([toolCallChunk('c2', 'echo', badArgs)]))
      .mockResolvedValueOnce(sseStream([toolCallChunk('c3', 'echo', badArgs)]));

    const events: AgentEvent[] = [];
    const res = await runAgent({
      apiKey: 'k',
      tools: [echoTool],
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      vfs: new VirtualFileSystem(),
      plannerModel: 'p',
      executorModel: 'e',
      maxIterations: 10,
      skipPlanner: true,
      onEvent: (e) => events.push(e),
    });

    expect(res.stoppedNoProgress).toBe(true);
    expect(res.iterations).toBeLessThanOrEqual(3);
    const np = events.find((e) => e.type === 'no_progress');
    expect(np && 'message' in np && np.message).toMatch(/no progress/i);
  });

  it('aborts cleanly via the signal (Stop button), reporting stoppedByUser', async () => {
    const controller = new AbortController();
    // First executor turn returns a tool call; abort fires before the tool runs.
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      return sseStream([toolCallChunk('c1', 'echo', '{"msg":"hi"}')]);
    });

    const vfs = new VirtualFileSystem();
    const res = await runAgent({
      apiKey: 'k',
      tools: [echoTool],
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      vfs,
      plannerModel: 'p',
      executorModel: 'e',
      skipPlanner: true,
      signal: controller.signal,
    });

    expect(res.stoppedByUser).toBe(true);
    // The tool never executed — nothing written.
    expect(vfs.readFile('package/touched.txt')).toBeNull();
  });
});

describe('LLM timeout guards', () => {
  afterEach(() => {
    delete process.env.AGENT_LLM_STALL_TIMEOUT_MS;
    delete process.env.AGENT_LLM_CONNECT_TIMEOUT_MS;
  });

  it('resolves timeouts from env with sane floors and fallbacks', () => {
    expect(resolveLlmConnectTimeout()).toBe(60_000);
    expect(resolveLlmStallTimeout()).toBe(120_000);
    process.env.AGENT_LLM_CONNECT_TIMEOUT_MS = '15000';
    process.env.AGENT_LLM_STALL_TIMEOUT_MS = '30000';
    expect(resolveLlmConnectTimeout()).toBe(15_000);
    expect(resolveLlmStallTimeout()).toBe(30_000);
    // Below the 1s floor / garbage → fallback.
    process.env.AGENT_LLM_STALL_TIMEOUT_MS = '5';
    expect(resolveLlmStallTimeout()).toBe(120_000);
    process.env.AGENT_LLM_STALL_TIMEOUT_MS = 'nope';
    expect(resolveLlmStallTimeout()).toBe(120_000);
  });

  it('readOpenRouterStream throws LlmTimeoutError when the stream stalls', async () => {
    process.env.AGENT_LLM_STALL_TIMEOUT_MS = '1000';
    const encoder = new TextEncoder();
    // Emits one delta then goes silent forever (the observed live hang).
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n'));
        // never closes
      },
    });
    const response = new Response(body);
    const deltas: string[] = [];
    await expect(
      readOpenRouterStream(response as globalThis.Response, (d) => deltas.push(d))
    ).rejects.toBeInstanceOf(LlmTimeoutError);
    // The pre-stall delta still streamed through.
    expect(deltas).toEqual(['partial']);
  });

  it('readOpenRouterStream completes normally when the stream ends', async () => {
    process.env.AGENT_LLM_STALL_TIMEOUT_MS = '5000';
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n'));
        controller.close();
      },
    });
    const res = await readOpenRouterStream(new Response(body) as globalThis.Response, () => {});
    expect(res.content).toBe('hi');
    expect(res.toolCalls).toEqual([]);
  });
});
