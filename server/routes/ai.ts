import { Router, Request, Response } from 'express';
import { resolveModelProfile } from '../../src/lib/ai/modelProfile.js';
import { VirtualFileSystem } from '../../src/lib/vfs.js';
import { sessionState, type Todo, type Decision } from '../../src/lib/ai/sessionState.js';
import { localDocsIndex } from '../services/localDocsIndex.js';
import { CORE_AGENT_TOOLS } from '../../src/lib/ai/coreTools.js';
import { resolveServerIntegrationTools, mcpGroundingEnabled } from '../services/agentTools.js';
import {
  runAgent,
  resolveMaxIterations,
  resolveNoProgressLimit,
  AGENT_MAX_ITERATIONS_CLAMP,
  type AgentEvent,
} from '../services/agentRunner.js';
import { resolveInspectMaxIterations } from '../services/agentLoop.js';
import {
  resolveToolPolicy,
  resolvePolicyMap,
  sanitizeOverrides,
  sessionApprovals,
  ASK_TOOLS,
  DEFAULT_TOOL_POLICY,
  mcpGroundingAuto,
  type ToolPolicy,
  type ResolvePolicyOptions,
} from '../services/toolPolicy.js';
import { approvalRegistry, type ApprovalDecision } from '../services/approvalRegistry.js';
import type { ApprovalGate } from '../services/agentRunner.js';
import { traceLogger } from '../services/traceLogger.js';
import { getToolCallingModels } from '../services/openrouterModels.js';

const router = Router();

type OpenAIMessage = {
  role: string;
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
};

type AgentTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, vfs: VirtualFileSystem) => Promise<string>;
};

/**
 * The exact tool set the server-side agent runs with. There is now ONE source of
 * truth for the primitive tools: `CORE_AGENT_TOOLS` (src/lib/ai/coreTools.ts),
 * the SAME definitions the browser-side fallback registry uses. The server simply
 * appends its privileged integration tools (MCP-as-tools + build_and_inspect,
 * which require node-only services and so cannot live in the browser bundle).
 *
 * Exported so the eval bench (eval/ucc-bench/runner.ts) drives the *same* agent
 * the UI does.
 */
/**
 * Resolve the server agent's tool set at REQUEST time. The primitive
 * CORE_AGENT_TOOLS are always present; build_and_inspect is always present; the
 * live-Splunk MCP grounding tools are included ONLY when AGENT_MCP_GROUNDING is
 * on (default OFF — a standard build is standalone). Resolved per call so the gate
 * honours the env flag without a server restart.
 */
function resolveServerTools(): AgentTool[] {
  return [
    ...(CORE_AGENT_TOOLS as AgentTool[]),
    ...(resolveServerIntegrationTools() as AgentTool[]),
  ];
}

// Back-compat: the eval bench imports SERVER_TOOLS. It reflects the current gate
// at import time (the bench enables grounding via env when it wants it).
const SERVER_TOOLS: AgentTool[] = resolveServerTools();

export { SERVER_TOOLS, resolveServerTools };

interface PersistedAgentState {
  todos: Todo[];
  decisions: Decision[];
  memory: Record<string, string>;
}

const AGENT_STATES = new Map<string, PersistedAgentState>();

function loadSessionState(sessionId: string) {
  const current = AGENT_STATES.get(sessionId);
  sessionState.clear();
  if (!current) return;
  sessionState.setTodos(current.todos);
  for (const d of current.decisions) {
    sessionState.recordDecision({
      id: d.id,
      question: d.question,
      decision: d.decision,
      rationale: d.rationale,
    });
  }
  for (const [k, v] of Object.entries(current.memory)) {
    sessionState.setMemory(k, v);
  }
}

function saveSessionState(sessionId: string) {
  AGENT_STATES.set(sessionId, {
    todos: sessionState.getTodos(),
    decisions: sessionState.getDecisions(),
    memory: sessionState.dumpMemory(),
  });
}

function writeSse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function openRouterApiKey(req?: Request): string | undefined {
  // Unified key: when embedded in Splunk, the app's REST proxy injects the
  // Configuration-page key as `X-OpenRouter-Key`; otherwise fall back to env.
  const hdr = req?.headers['x-openrouter-key'];
  const fromHeader = Array.isArray(hdr) ? hdr[0] : hdr;
  const trimmed = fromHeader ? String(fromHeader).trim() : '';
  return trimmed || process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_APIKEY;
}

/**
 * GET /api/ai/config
 * Returns AI configuration to the frontend.
 * If OPENROUTER_API_KEY (or legacy OPENROUTER_APIKEY) is set, the server will proxy requests.
 */
/**
 * GET /api/ai/models
 * Tool-calling-capable models from OpenRouter for the Settings picker
 * (cached 1h server-side). Returns { models: [] } on failure — the UI then
 * falls back to its static list.
 */
router.get('/ai/models', async (_req: Request, res: Response) => {
  const { models, cached } = await getToolCallingModels();
  res.json({ models, cached });
});

router.get('/ai/config', (req: Request, res: Response) => {
  const serverManaged = !!openRouterApiKey(req);
  const profile = resolveModelProfile();
  res.json({
    serverManaged,
    profile: profile.name,
    models: profile.models,
    // Back-compat: the current AIChatPanel still reads `defaultModel`.
    defaultModel: profile.models.executor,
    notes: profile.notes,
    capabilities: {
      dockerToolsEnabled: envFlag('UCC_ENABLE_DOCKER_TOOLS', false),
      browserCheckEnabled: envFlag('UCC_ENABLE_BROWSER_CHECK', false),
      localDocsIndexEnabled: envFlag('UCC_ENABLE_LOCAL_DOCS_INDEX', true),
      // Live-Splunk MCP grounding tools (get_live_indexes / get_splunk_metadata /
      // run_splunk_query / generate_spl). Default OFF — a standard build is
      // standalone. Enable with AGENT_MCP_GROUNDING=1 to ground in live Splunk.
      mcpGroundingEnabled: mcpGroundingEnabled(),
    },
    // Agent-loop limits (env-configurable defaults; explicit request args win).
    // The Settings UI reads `agent.maxIterations` to seed its control.
    agent: {
      maxIterations: resolveMaxIterations(),
      maxIterationsMin: AGENT_MAX_ITERATIONS_CLAMP.min,
      maxIterationsMax: AGENT_MAX_ITERATIONS_CLAMP.max,
      inspectMaxIterations: resolveInspectMaxIterations(),
      noProgressLimit: resolveNoProgressLimit(),
    },
    // Tool-approval policy. `policy` is the EFFECTIVE map (built-in defaults +
    // AGENT_MCP_GROUNDING + AGENT_TOOL_POLICY) the server will apply; the Settings
    // UI seeds its toggles from it and may send per-tool overrides back per request.
    // `askTools` lists the external-access tools that default to first-use approval.
    toolPolicy: {
      policy: resolvePolicyMap(Object.keys(DEFAULT_TOOL_POLICY)),
      askTools: [...ASK_TOOLS],
      mcpGroundingAuto: mcpGroundingAuto(),
    },
  });
});

/**
 * POST /api/ai/chat
 * Proxies chat completion requests to OpenRouter using the server-side API key.
 * Only available when OPENROUTER_API_KEY (or legacy OPENROUTER_APIKEY) is set.
 */
router.post('/ai/chat', async (req: Request, res: Response) => {
  const apiKey = openRouterApiKey(req);

  if (!apiKey) {
    return res.status(403).json({
      error: 'Server-managed AI is not configured. Set OPENROUTER_API_KEY env variable.',
    });
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://splunk.engineer',
        'X-Title': 'UCCBuilder',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('AI Proxy Error:', message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/ai/agent/stream
 * Server-side planner/executor loop with SSE streaming.
 */
router.post('/ai/agent/stream', async (req: Request, res: Response) => {
  const apiKey = openRouterApiKey(req);
  if (!apiKey) {
    return res.status(403).json({
      error: 'Server-managed AI is not configured. Set OPENROUTER_API_KEY env variable.',
    });
  }

  const profile = resolveModelProfile();
  const { sessionId, model, system, messages, files, maxIterations, toolPolicy } = req.body ?? {};

  const initialMessages = Array.isArray(messages) ? (messages as OpenAIMessage[]) : [];
  const systemPrompt = typeof system === 'string' ? system : '';
  const sid = typeof sessionId === 'string' && sessionId.trim() ? sessionId : 'default';

  // Per-request policy overrides from the Settings UI (validated; invalid → {}).
  const policyOverrides = sanitizeOverrides(toolPolicy);
  const policyOpts: ResolvePolicyOptions = { overrides: policyOverrides };
  const selectedModel = typeof model === 'string' && model.trim() ? model : profile.models.executor;
  const plannerModel = profile.models.planner || selectedModel;
  // Explicit request value wins; otherwise AGENT_MAX_ITERATIONS env, else 12.
  // Always clamped to [1,20].
  const iterationsLimit = resolveMaxIterations(
    Number.isFinite(Number(maxIterations)) ? Number(maxIterations) : undefined
  );

  const vfs = new VirtualFileSystem();
  const incomingFiles = Array.isArray(files) ? files : [];
  for (const file of incomingFiles) {
    const path = String(file?.path || '');
    const content = String(file?.content || '');
    if (!path) continue;
    vfs.writeFile(path, content, 'user');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Approval gate: resolve each tool's policy, remember session approvals, and
  // for `ask`-policy tools that are not yet session-approved, emit an
  // `approval_request` SSE frame and AWAIT the user's decision (via the
  // POST /api/ai/agent/approve endpoint, keyed by approvalId). `auto` runs
  // silently; `deny` is refused outright; a timeout is treated as deny.
  const approvalGate: ApprovalGate = async ({ tool, args }) => {
    const policy: ToolPolicy = resolveToolPolicy(tool, policyOpts);

    if (policy === 'auto') return { action: 'run' };

    if (policy === 'deny') {
      return {
        action: 'skip',
        message: `Tool "${tool}" is denied by policy and was not run. Proceed without it; do not retry it.`,
      };
    }

    // policy === 'ask'
    if (sessionApprovals.isApproved(sid, tool)) {
      return { action: 'run' };
    }

    const reason =
      `"${tool}" needs your approval because it has external access ` +
      `(it can reach outside this build sandbox). Approve once, approve for the whole session, or deny.`;
    const { approvalId, promise } = approvalRegistry.register({
      tool,
      sessionId: sid,
      onTimeout: () => writeSse(res, 'approval_timeout', { approvalId, tool }),
    });
    writeSse(res, 'approval_request', { approvalId, tool, args, reason });

    const outcome = await promise;
    if (outcome.decision === 'approve_session') {
      sessionApprovals.approveForSession(sid, tool);
      return { action: 'run' };
    }
    if (outcome.decision === 'approve') {
      return { action: 'run' };
    }
    // 'deny' (explicit or timeout)
    const why = outcome.timedOut ? 'timed out waiting for approval' : 'declined by the user';
    return {
      action: 'skip',
      message: `User ${why} for "${tool}". Proceed without it; do not retry it.`,
    };
  };

  // Abort: a client disconnect (including the UI's Stop button closing the
  // stream) cancels the run server-side — stops the LLM spend, not just the UI.
  // NOTE: listen on the RESPONSE, not the request — since Node 16,
  // IncomingMessage emits 'close' when the request body is fully received
  // (i.e. immediately for a POST), which aborted every run at iteration 0.
  // res 'close' with writableEnded=false means the connection died early.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  // Every chat run leaves a JSONL trace (.ucc-agent/traces/chat-<sid>-<ts>.jsonl)
  // so a failed/looping run can be replayed and diagnosed after the fact.
  const traceId = `chat-${sid}-${Date.now()}`;
  const trace = (
    kind: 'tool_call' | 'tool_result' | 'error' | 'note',
    name: string,
    payload: Record<string, unknown>
  ) => void traceLogger.log({ sessionId: traceId, kind, name, payload });
  const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s);

  try {
    loadSessionState(sid);
    trace('note', 'request', {
      model: selectedModel,
      iterationsLimit,
      lastUserMessage: clip(
        String(initialMessages.filter((m) => m.role === 'user').pop()?.content ?? '')
      ),
    });

    // Drive the SHARED agent core. routes/ai.ts and the eval bench now run the
    // IDENTICAL planner/executor loop (server/services/agentRunner.ts). This
    // handler only translates the runner's transport-agnostic events into SSE
    // frames and persists session-state side-effects per tool result.
    const result = await runAgent({
      apiKey,
      tools: resolveServerTools(),
      systemPrompt,
      messages: initialMessages,
      vfs,
      plannerModel,
      executorModel: selectedModel,
      maxIterations: iterationsLimit,
      approvalGate,
      signal: abort.signal,
      onEvent: (e: AgentEvent) => {
        switch (e.type) {
          case 'planner':
            writeSse(res, 'planner', { content: e.content });
            trace('note', 'planner', { content: clip(e.content) });
            break;
          case 'iteration':
            writeSse(res, 'iteration', { index: e.index });
            trace('note', 'iteration', { index: e.index });
            break;
          case 'assistant_delta':
            writeSse(res, 'assistant_delta', { content: e.content });
            break;
          case 'tool_call':
            writeSse(res, 'tool_call', { id: e.id, name: e.name, arguments: e.arguments });
            trace('tool_call', e.name, { id: e.id, arguments: clip(e.arguments) });
            break;
          case 'tool_result':
            // Persist after every tool result (idempotent) so session memory,
            // todos and decisions survive a disconnect mid-run — matches the
            // previous per-tool saveSessionState behaviour.
            saveSessionState(sid);
            writeSse(res, 'tool_result', { id: e.id, name: e.name, content: e.content });
            trace('tool_result', e.name, { id: e.id, content: clip(e.content) });
            if (e.name === 'todo_write') {
              writeSse(res, 'todos', { items: sessionState.getTodos() });
            }
            if (e.name === 'record_decision') {
              writeSse(res, 'decisions', { items: sessionState.getDecisions() });
            }
            break;
          case 'no_progress':
            writeSse(res, 'no_progress', {
              message: e.message,
              tool: e.tool,
              lastError: e.lastError,
            });
            trace('note', 'no_progress', {
              message: e.message,
              tool: e.tool,
              lastError: clip(e.lastError),
            });
            break;
          case 'warning':
            writeSse(res, 'warning', { message: e.message });
            trace('note', 'warning', { message: e.message });
            break;
          case 'usage':
            writeSse(res, 'usage', {
              promptTokens: e.promptTokens,
              completionTokens: e.completionTokens,
              totalTokens: e.totalTokens,
            });
            break;
          case 'error':
            writeSse(res, 'error', { error: e.error });
            trace('error', 'agent_error', { error: clip(e.error) });
            break;
        }
      },
    });

    trace('note', 'final', {
      iterations: result.iterations,
      hitIterationLimit: result.hitIterationLimit,
      stoppedNoProgress: result.stoppedNoProgress,
      stoppedByUser: result.stoppedByUser,
      content: clip(result.finalContent, 2000),
    });

    saveSessionState(sid);
    writeSse(res, 'todos', { items: sessionState.getTodos() });
    writeSse(res, 'decisions', { items: sessionState.getDecisions() });
    writeSse(res, 'files', { files: vfs.getAllFiles() });
    writeSse(res, 'done', { ok: true, stoppedByUser: result.stoppedByUser });
    res.end();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    trace('error', 'route_error', { error: message });
    writeSse(res, 'error', { error: message });
    res.end();
  }
});

/**
 * POST /api/ai/agent/approve
 * Resolve a pending tool-approval raised by the SSE pause/resume handshake.
 * Body: { approvalId, decision: 'approve' | 'approve_session' | 'deny' }.
 *  - approve         → run the tool this once.
 *  - approve_session → run it now AND remember it for the rest of the session.
 *  - deny            → refuse the tool; the agent is told to proceed without it.
 * `approve_session` also records the tool in the session-approved set so later
 * calls in the same session run automatically. Returns 404 if the approvalId is
 * unknown (already settled or timed out).
 */
router.post('/ai/agent/approve', (req: Request, res: Response) => {
  const { approvalId, decision } = req.body ?? {};
  const validDecisions: ApprovalDecision[] = ['approve', 'approve_session', 'deny'];
  if (typeof approvalId !== 'string' || !approvalId.trim()) {
    return res.status(400).json({ error: 'approvalId is required' });
  }
  if (!validDecisions.includes(decision as ApprovalDecision)) {
    return res.status(400).json({ error: `decision must be one of: ${validDecisions.join(', ')}` });
  }
  const resolved = approvalRegistry.resolve(approvalId, decision as ApprovalDecision);
  if (!resolved) {
    return res
      .status(404)
      .json({ error: 'No pending approval for that approvalId (already settled or timed out).' });
  }
  res.json({ ok: true, approvalId, decision });
});

/**
 * POST /api/ai/context
 * Proxies requests to an external RAG/Context service (e.g., Upstash Context7).
 * Requires CONTEXT_API_URL and optionally CONTEXT_API_KEY.
 */
router.post('/ai/context', async (req: Request, res: Response) => {
  const contextUrl = process.env.CONTEXT_API_URL;
  const contextKey = process.env.CONTEXT_API_KEY;
  const localIndexEnabled = envFlag('UCC_ENABLE_LOCAL_DOCS_INDEX', true);
  const query = String(req.body?.query ?? '').trim();

  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }

  if (localIndexEnabled) {
    const localResults = await localDocsIndex.search(query, 8);
    if (localResults.length > 0) {
      return res.json({
        source: 'local-flexsearch',
        results: localResults,
      });
    }
  }

  if (!contextUrl) {
    return res.status(200).json({
      source: localIndexEnabled ? 'local-flexsearch' : 'none',
      results: [],
      note: localIndexEnabled
        ? 'No local match and no external context service configured.'
        : 'Local docs index disabled and CONTEXT_API_URL not configured.',
    });
  }

  try {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (contextKey) {
      headers['Authorization'] = `Bearer ${contextKey}`;
    }

    const response = await fetch(contextUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Context Proxy Error:', message);
    res.status(500).json({ error: message });
  }
});

router.get('/ai/context/local/status', async (_req: Request, res: Response) => {
  const enabled = envFlag('UCC_ENABLE_LOCAL_DOCS_INDEX', true);
  if (!enabled) {
    return res.json({
      enabled: false,
      reason: 'UCC_ENABLE_LOCAL_DOCS_INDEX=false',
    });
  }
  const stats = await localDocsIndex.stats();
  res.json({
    enabled: true,
    ...stats,
  });
});

router.post('/ai/context/local/rebuild', async (_req: Request, res: Response) => {
  const enabled = envFlag('UCC_ENABLE_LOCAL_DOCS_INDEX', true);
  if (!enabled) {
    return res.status(403).json({ error: 'Local docs index is disabled.' });
  }
  const stats = await localDocsIndex.rebuild();
  res.json({
    rebuilt: true,
    ...stats,
  });
});

export { router as aiRouter };
