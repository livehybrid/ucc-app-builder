/**
 * Reusable tool-calling agent runner.
 *
 * This is the core planner/executor loop, extracted from routes/ai.ts so it can
 * be driven by BOTH:
 *   - the SSE route (POST /api/ai/agent/stream) — streams events to the browser, and
 *   - the eval bench (eval/ucc-bench/runner.ts) — collects events headlessly.
 *
 * It is transport-agnostic: callers pass an `onEvent` callback and get back the
 * final VFS, the assistant's last message, and the iteration count.
 */

import type { VirtualFileSystem } from '../../src/lib/vfs.js';

export type AgentRunnerTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, vfs: VirtualFileSystem) => Promise<string>;
};

export type OpenAIMessage = {
  role: string;
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
};

export type AgentEvent =
  | { type: 'planner'; content: string }
  | { type: 'iteration'; index: number }
  | { type: 'assistant_delta'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; id: string; name: string; content: string }
  | { type: 'warning'; message: string }
  | { type: 'no_progress'; message: string; tool: string; lastError: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: 'error'; error: string };

/**
 * The outcome of an approval gate decision for one tool call. `run` lets the tool
 * execute; `skip` refuses it and feeds {@link ApprovalGateResult.message} back to
 * the agent as the tool result so it can adapt (e.g. a deny / timeout).
 */
export type ApprovalGateResult = { action: 'run' } | { action: 'skip'; message: string };

/**
 * Optional gate consulted BEFORE a tool executes. Returns `run` to proceed or
 * `skip` (with a message fed to the agent) to refuse. The SSE route uses this to
 * implement the pause/resume approval handshake; the eval bench omits it (auto-run).
 */
export type ApprovalGate = (call: {
  tool: string;
  args: Record<string, unknown>;
  rawArgs: string;
  id: string;
}) => Promise<ApprovalGateResult>;

export interface AgentRunOptions {
  apiKey: string;
  tools: AgentRunnerTool[];
  systemPrompt: string;
  messages: OpenAIMessage[];
  vfs: VirtualFileSystem;
  plannerModel: string;
  executorModel: string;
  maxIterations?: number;
  /**
   * No-progress breaker threshold: if the agent issues the SAME (tool+args)
   * producing an error or identical result this many times consecutively, the
   * loop stops early to avoid burning iterations (and OpenRouter spend) going in
   * circles. Default {@link DEFAULT_NO_PROGRESS_LIMIT} (3). A Security Error for
   * the same path twice always breaks immediately, regardless of this value.
   */
  noProgressLimit?: number;
  /** Skip the non-tool planning turn (faster, deterministic for evals). */
  skipPlanner?: boolean;
  /**
   * Optional per-tool approval gate. When provided, it is awaited BEFORE each tool
   * executes; returning `skip` refuses the tool and feeds its message back to the
   * agent. Omit it (the eval bench does) to run every tool unconditionally.
   */
  approvalGate?: ApprovalGate;
  /**
   * Optional abort signal (Stop button / client disconnect). Checked between
   * iterations and tool calls, and passed to the OpenRouter fetches so an
   * in-flight LLM request is cancelled immediately (stops spend, not just UI).
   */
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

export interface AgentRunResult {
  iterations: number;
  finalContent: string;
  hitIterationLimit: boolean;
  /** True when the no-progress breaker stopped the loop (repeated failing/identical tool call). */
  stoppedNoProgress: boolean;
  /** True when the run was aborted via {@link AgentRunOptions.signal} (Stop button / disconnect). */
  stoppedByUser: boolean;
  plannerText: string;
  /** Cumulative token usage across all executor turns this run (if the provider reported it). */
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

// ---------------------------------------------------------------------------
// Defaults — env vars provide the DEFAULTS only; explicit args always win.
// ---------------------------------------------------------------------------

export const AGENT_MAX_ITERATIONS_CLAMP = { min: 1, max: 20 } as const;
const FALLBACK_MAX_ITERATIONS = 12;
export const DEFAULT_NO_PROGRESS_LIMIT = 3;

/** Resolve & clamp the iteration limit from an explicit value, falling back to AGENT_MAX_ITERATIONS, then 12. */
export function resolveMaxIterations(explicit?: number): number {
  const fromEnv = Number(process.env.AGENT_MAX_ITERATIONS);
  const raw = Number.isFinite(Number(explicit))
    ? Number(explicit)
    : Number.isFinite(fromEnv)
      ? fromEnv
      : FALLBACK_MAX_ITERATIONS;
  return Math.max(AGENT_MAX_ITERATIONS_CLAMP.min, Math.min(AGENT_MAX_ITERATIONS_CLAMP.max, raw));
}

/** Resolve the no-progress breaker threshold from an explicit value, falling back to AGENT_NO_PROGRESS_LIMIT, then 3. */
export function resolveNoProgressLimit(explicit?: number): number {
  const fromEnv = Number(process.env.AGENT_NO_PROGRESS_LIMIT);
  const raw = Number.isFinite(Number(explicit))
    ? Number(explicit)
    : Number.isFinite(fromEnv)
      ? fromEnv
      : DEFAULT_NO_PROGRESS_LIMIT;
  // At least 2 — a single repeat can be legitimate; breaking on 1 would be too eager.
  return Math.max(2, Math.floor(raw));
}

/**
 * Deterministic JSON stringify with sorted keys, so two semantically-identical
 * argument objects produce the same signature regardless of key order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Tiny stable hash (djb2) for collapsing tool-result strings into a signature. */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Does a tool result look like an error / security rejection the agent should not retry verbatim? */
function looksLikeError(content: string): boolean {
  return /(^|\b)(error|failed|invalid|not available|denied|forbidden|security error)\b/i.test(
    content
  );
}

function isSecurityError(content: string): boolean {
  return /security error/i.test(content);
}

/**
 * Build the no-progress signature for one tool execution:
 *   toolName + stable(args) + (errored ? 'ERR' : result-hash)
 * Two consecutive executions with the same signature mean "the model repeated
 * the exact same action and got the exact same (failing or unchanged) outcome".
 */
function toolSignature(
  toolName: string,
  args: Record<string, unknown>,
  result: string,
  errored: boolean
): string {
  const tail = errored ? 'ERR' : `R:${hashString(result)}`;
  return `${toolName}|${stableStringify(args)}|${tail}`;
}

type ToolCallChunk = {
  id?: string;
  function?: { name?: string; arguments?: string };
  /** Present on OpenAI-spec streams; some providers omit it (see ToolCallAccumulator). */
  index?: number;
};

/**
 * Timeouts guarding OpenRouter calls. Without these a hung provider left the
 * iteration spinning forever (observed live: an Opus call silent for 5+ min).
 * Connect covers time-to-response-headers; stall covers the max gap between
 * stream chunks (a healthy stream emits deltas every few seconds).
 */
const FALLBACK_LLM_CONNECT_TIMEOUT_MS = 60_000;
const FALLBACK_LLM_STALL_TIMEOUT_MS = 120_000;

function resolveTimeoutMs(envName: string, fallback: number): number {
  const raw = Number(process.env[envName]);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : fallback;
}

export function resolveLlmConnectTimeout(): number {
  return resolveTimeoutMs('AGENT_LLM_CONNECT_TIMEOUT_MS', FALLBACK_LLM_CONNECT_TIMEOUT_MS);
}

export function resolveLlmStallTimeout(): number {
  return resolveTimeoutMs('AGENT_LLM_STALL_TIMEOUT_MS', FALLBACK_LLM_STALL_TIMEOUT_MS);
}

/** A provider hang surfaced as an error (distinct from a user-initiated abort). */
export class LlmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}

async function callOpenRouter(
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<globalThis.Response> {
  // Internal controller: aborted by EITHER the caller's signal (user stop /
  // client disconnect) or the connect timer. It also governs the response
  // body, so a user abort still cancels mid-stream.
  const ctrl = new AbortController();
  signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  const connectMs = resolveLlmConnectTimeout();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, connectMs);
  try {
    return await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://splunk.engineer',
        'X-Title': 'UCCBuilder',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (timedOut && !signal?.aborted) {
      throw new LlmTimeoutError(
        `OpenRouter did not respond within ${Math.round(connectMs / 1000)}s (provider hang). ` +
          'Try again, or pick a different model in Settings.'
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** True for fetch/stream errors caused by an AbortSignal firing. */
function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message));
}

type AccumulatedToolCall = { id: string; function: { name: string; arguments: string } };

/** Is `s` (trimmed) a complete, parseable JSON value? Used to detect call boundaries. */
function isCompleteJson(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/**
 * Accumulate streamed tool-call chunks into discrete tool calls.
 *
 * OpenAI-compatible providers key continuation chunks by `index`, with one
 * index per parallel call. Some providers (e.g. Kimi via OpenRouter) omit
 * `index` or REUSE index 0 for separate sequential calls — naive index-keying
 * then concatenates two calls' JSON arguments into one unparsable blob
 * ("Unexpected non-whitespace character after JSON at position N"), or merges
 * a call missing its `path` into another. We split into a NEW call when:
 *   - a chunk lands on an entry whose `id` differs from the chunk's `id`, or
 *   - the entry's arguments already form complete JSON and the chunk starts a
 *     fresh JSON object (`{`) — a repeat call that reused the same slot.
 * A split without a fresh `function.name` inherits the previous call's name.
 */
export class ToolCallAccumulator {
  private entries: AccumulatedToolCall[] = [];
  private keyed = new Map<string, number>();
  private lastIdx = -1;

  private newEntry(id: string, name: string): number {
    this.entries.push({ id, function: { name, arguments: '' } });
    return this.entries.length - 1;
  }

  add(tc: ToolCallChunk): void {
    const key = typeof tc.index === 'number' ? `i:${tc.index}` : tc.id ? `id:${tc.id}` : null;
    let idx = key !== null && this.keyed.has(key) ? (this.keyed.get(key) as number) : -1;
    if (idx === -1 && key === null) idx = this.lastIdx; // bare continuation chunk
    if (idx === -1) {
      idx = this.newEntry(tc.id || '', '');
      if (key !== null) this.keyed.set(key, idx);
    } else {
      const entry = this.entries[idx];
      const differentId = !!tc.id && !!entry.id && tc.id !== entry.id;
      const startsNewJson =
        !!tc.function?.arguments &&
        /^\s*\{/.test(tc.function.arguments) &&
        isCompleteJson(entry.function.arguments);
      if (differentId || startsNewJson) {
        idx = this.newEntry(tc.id || '', tc.function?.name ? '' : entry.function.name);
        if (key !== null) this.keyed.set(key, idx);
      }
    }
    const entry = this.entries[idx];
    if (tc.id && !entry.id) entry.id = tc.id;
    if (tc.function?.name) entry.function.name += tc.function.name;
    if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
    this.lastIdx = idx;
  }

  /** Finalized calls, with fallback ids so every call is uniquely addressable. */
  finalize(): AccumulatedToolCall[] {
    return this.entries.map((e, i) => ({
      id: e.id || `call_${i}`,
      function: e.function,
    }));
  }
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export async function readOpenRouterStream(
  response: globalThis.Response,
  onDelta: (content: string) => void
): Promise<{ content: string; toolCalls: AccumulatedToolCall[]; usage?: TokenUsage }> {
  if (!response.body) throw new Error('OpenRouter response body is null.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: TokenUsage | undefined;
  const accumulator = new ToolCallAccumulator();
  const stallMs = resolveLlmStallTimeout();

  for (;;) {
    // Stall watchdog: a healthy stream produces chunks every few seconds. If
    // the provider goes silent, fail the iteration instead of hanging it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: { done: boolean; value?: Uint8Array };
    try {
      result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new LlmTimeoutError(
                  `LLM stream stalled — no data received for ${Math.round(stallMs / 1000)}s ` +
                    '(provider hang). Try again, or pick a different model in Settings.'
                )
              ),
            stallMs
          );
        }),
      ]);
    } catch (e) {
      void reader.cancel().catch(() => {});
      throw e;
    } finally {
      clearTimeout(timer);
    }
    const { done, value } = result;
    if (done) break;
    if (!value) continue;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6);
      try {
        const json = JSON.parse(payload);
        // The final chunk carries usage when include_usage is requested. It may
        // arrive on a chunk with an empty choices array.
        if (json.usage) {
          usage = {
            prompt_tokens: Number(json.usage.prompt_tokens ?? 0),
            completion_tokens: Number(json.usage.completion_tokens ?? 0),
            total_tokens: Number(json.usage.total_tokens ?? 0),
          };
        }
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          onDelta(delta.content);
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls as ToolCallChunk[]) {
            accumulator.add(tc);
          }
        }
      } catch {
        // ignore malformed chunks
      }
    }
  }

  return { content, toolCalls: accumulator.finalize(), usage };
}

function toOpenAIToolFormat(tools: AgentRunnerTool[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Run the planner/executor tool-calling loop to completion against `opts.vfs`.
 * Side effects (file writes) land in the passed VFS; events stream via onEvent.
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const emit = (e: AgentEvent) => opts.onEvent?.(e);
  const iterationsLimit = resolveMaxIterations(opts.maxIterations);
  const noProgressLimit = resolveNoProgressLimit(opts.noProgressLimit);

  // Planner seam: a quick non-tool planning turn.
  let plannerText = '';
  if (!opts.skipPlanner) {
    try {
      const plannerResp = await callOpenRouter(
        opts.apiKey,
        {
          model: opts.plannerModel,
          messages: [
            {
              role: 'system',
              content:
                `${opts.systemPrompt}\n\nYou are the planning phase. Produce a concise 3-6 step plan. ` +
                'Do not call tools; this is planning only.',
            },
            ...opts.messages,
          ],
          stream: false,
          max_tokens: 400,
        },
        opts.signal
      );
      const plannerJson = await plannerResp.json();
      plannerText = plannerJson?.choices?.[0]?.message?.content || '';
      if (plannerText) emit({ type: 'planner', content: plannerText });
    } catch {
      // Planning is best-effort; continue without it.
    }
  }

  // The planner output is guidance, NOT a second conversation turn. It MUST be
  // folded into the single system message: Anthropic (and the Bedrock/Vertex
  // proxies behind OpenRouter) reject a second `system` message sitting at
  // messages[1] — "role 'system' must follow a 'user' message or an 'assistant'
  // message ...". Keeping exactly one system message keeps every provider happy.
  const systemContent = plannerText
    ? `${opts.systemPrompt}\n\n## Plan for this turn (follow unless the user contradicts it)\n${plannerText}`
    : opts.systemPrompt;

  const apiMessages: OpenAIMessage[] = [
    { role: 'system', content: systemContent },
    ...opts.messages,
  ];

  const openAiTools = toOpenAIToolFormat(opts.tools);
  const toolMap = new Map(opts.tools.map((t) => [t.name, t]));

  let keepGoing = true;
  let iterations = 0;
  let finalContent = '';
  let stoppedNoProgress = false;
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  // No-progress tracking: the signature of the LAST tool execution, how many
  // times in a row it has now repeated, and the last error text (for the event).
  let lastSignature: string | null = null;
  let repeatCount = 0;
  let lastErrorText = '';
  // Security errors: a path that has already been refused once. Two refusals for
  // the same path → break immediately (the agent cannot fix a sandbox rejection
  // by retrying — surface the guidance instead).
  const securityRefusedSignatures = new Set<string>();

  let stoppedByUser = false;

  while (keepGoing && iterations < iterationsLimit) {
    if (opts.signal?.aborted) {
      stoppedByUser = true;
      break;
    }
    iterations++;
    emit({ type: 'iteration', index: iterations });

    let content: string;
    let toolCalls: AccumulatedToolCall[];
    try {
      const execResp = await callOpenRouter(
        opts.apiKey,
        {
          model: opts.executorModel,
          messages: apiMessages,
          stream: true,
          // Ask OpenRouter to emit a final usage chunk so we can report tokens/cost.
          stream_options: { include_usage: true },
          max_tokens: 4096,
          tools: openAiTools,
        },
        opts.signal
      );

      if (!execResp.ok) {
        const err = await execResp.text();
        emit({ type: 'error', error: `Executor model error (${execResp.status}): ${err}` });
        break;
      }

      let turnUsage: TokenUsage | undefined;
      ({ content, toolCalls, usage: turnUsage } = await readOpenRouterStream(execResp, (delta) =>
        emit({ type: 'assistant_delta', content: delta })
      ));
      if (turnUsage) {
        usage.promptTokens += turnUsage.prompt_tokens;
        usage.completionTokens += turnUsage.completion_tokens;
        usage.totalTokens += turnUsage.total_tokens;
        emit({
          type: 'usage',
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        });
      }
    } catch (e: unknown) {
      if (opts.signal?.aborted) {
        stoppedByUser = true;
        break;
      }
      if (e instanceof LlmTimeoutError) {
        // Provider hang: end the run with a visible error instead of an
        // indefinitely-spinning iteration (or a misleading "stopped by user").
        emit({ type: 'error', error: e.message });
        break;
      }
      if (isAbortError(e)) {
        stoppedByUser = true;
        break;
      }
      throw e;
    }
    finalContent = content || finalContent;

    apiMessages.push({
      role: 'assistant',
      content,
      tool_calls: toolCalls.length
        ? toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: tc.function }))
        : undefined,
    });

    if (!toolCalls.length) {
      keepGoing = false;
      break;
    }

    // Records a tool outcome and feeds the no-progress breaker. Returns a reason
    // string when the loop should stop (repeated failure / repeated identical
    // result / repeated security refusal), or null to continue.
    const recordOutcome = (
      toolName: string,
      args: Record<string, unknown>,
      content: string,
      errored: boolean
    ): string | null => {
      // Security refusal for the same (tool+path) twice → break immediately.
      if (isSecurityError(content)) {
        const secSig = `SEC|${toolName}|${stableStringify(args)}`;
        if (securityRefusedSignatures.has(secSig)) {
          lastErrorText = content;
          return `Stopped: ${toolName} hit a Security Error twice for the same path — ${content.trim()}`;
        }
        securityRefusedSignatures.add(secSig);
      }

      const sig = toolSignature(toolName, args, content, errored);
      if (sig === lastSignature) {
        repeatCount += 1;
      } else {
        lastSignature = sig;
        repeatCount = 1;
      }
      if (errored || looksLikeError(content)) lastErrorText = content;

      if (repeatCount >= noProgressLimit) {
        const detail = lastErrorText ? ` — ${lastErrorText.trim()}` : '';
        return `Stopped: repeated ${toolName} with no progress (${repeatCount}x identical ${errored ? 'failure' : 'result'})${detail}`;
      }
      return null;
    };

    let breakReason: string | null = null;
    let breakTool = '';

    for (const toolCall of toolCalls) {
      if (opts.signal?.aborted) {
        stoppedByUser = true;
        break;
      }
      const toolName = toolCall.function.name;
      const tool = toolMap.get(toolName);
      emit({
        type: 'tool_call',
        id: toolCall.id,
        name: toolName,
        arguments: toolCall.function.arguments,
      });

      if (!tool) {
        const message = `Tool ${toolName} not available in server loop.`;
        apiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolName,
          content: message,
        });
        emit({ type: 'tool_result', id: toolCall.id, name: toolName, content: message });
        // Feed the breaker: repeatedly calling a nonexistent tool is no progress.
        const reason = recordOutcome(toolName, { __noSuchTool: true }, message, true);
        if (reason && !breakReason) {
          breakReason = reason;
          breakTool = toolName;
        }
        continue;
      }

      let argsObj: Record<string, unknown> = {};
      try {
        argsObj = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
      } catch (e: unknown) {
        const message =
          `Invalid tool arguments for ${toolName}: ${e instanceof Error ? e.message : String(e)}. ` +
          'Emit the arguments as ONE valid JSON object.';
        apiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolName,
          content: message,
        });
        emit({ type: 'tool_result', id: toolCall.id, name: toolName, content: message });
        // Feed the breaker keyed by error class (the corrupted args themselves
        // vary per attempt): N consecutive unparsable calls to the same tool
        // means the model cannot recover — stop instead of burning iterations.
        const reason = recordOutcome(toolName, { __invalidArgs: true }, message, true);
        if (reason && !breakReason) {
          breakReason = reason;
          breakTool = toolName;
        }
        continue;
      }

      // Approval gate: pause before executing an `ask`-policy tool the user has
      // not yet approved. A `skip` outcome (deny / timeout / deny-policy) refuses
      // the tool and feeds the gate's message back to the agent so it adapts.
      if (opts.approvalGate) {
        let gate: ApprovalGateResult;
        try {
          gate = await opts.approvalGate({
            tool: toolName,
            args: argsObj,
            rawArgs: toolCall.function.arguments || '',
            id: toolCall.id,
          });
        } catch (e: unknown) {
          gate = {
            action: 'skip',
            message: `Approval for ${toolName} failed: ${e instanceof Error ? e.message : String(e)}. Proceed without it.`,
          };
        }
        if (gate.action === 'skip') {
          apiMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: gate.message,
          });
          emit({ type: 'tool_result', id: toolCall.id, name: toolName, content: gate.message });
          // A refusal is a terminal outcome for this call — do not feed it to the
          // no-progress breaker (the agent should be free to try an alternative).
          continue;
        }
      }

      let resultContent: string;
      let errored = false;
      try {
        resultContent = await tool.execute(argsObj, opts.vfs);
      } catch (e: unknown) {
        resultContent = `Tool ${toolName} failed: ${e instanceof Error ? e.message : String(e)}`;
        errored = true;
      }
      apiMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolName,
        content: resultContent,
      });
      emit({ type: 'tool_result', id: toolCall.id, name: toolName, content: resultContent });

      const reason = recordOutcome(toolName, argsObj, resultContent, errored);
      if (reason && !breakReason) {
        breakReason = reason;
        breakTool = toolName;
      }
    }

    if (stoppedByUser) break;

    if (breakReason) {
      stoppedNoProgress = true;
      keepGoing = false;
      emit({
        type: 'no_progress',
        message: breakReason,
        tool: breakTool,
        lastError: lastErrorText,
      });
      emit({ type: 'warning', message: breakReason });
      break;
    }
  }

  if (stoppedByUser) {
    emit({ type: 'warning', message: 'Stopped by user.' });
    return {
      iterations,
      finalContent,
      hitIterationLimit: false,
      stoppedNoProgress,
      stoppedByUser,
      plannerText,
      usage,
    };
  }

  const hitIterationLimit = iterations >= iterationsLimit && keepGoing;
  if (hitIterationLimit)
    emit({ type: 'warning', message: `Reached max iterations (${iterationsLimit}).` });

  return {
    iterations,
    finalContent,
    hitIterationLimit,
    stoppedNoProgress,
    stoppedByUser: false,
    plannerText,
    usage,
  };
}
