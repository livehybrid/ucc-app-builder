import { Router, Request, Response } from 'express';
import { resolveModelProfile } from '../../src/lib/ai/modelProfile.js';
import { VirtualFileSystem } from '../../src/lib/vfs.js';
import { sessionState, type Todo, type Decision } from '../../src/lib/ai/sessionState.js';
import { localDocsIndex } from '../services/localDocsIndex.js';
import {
  applyPatch as applyParsedPatch,
  parsePatch,
  PatchApplyError,
  PatchParseError,
} from '../../src/lib/ai/patch.js';
import {
  formatSplunkSdkEntries,
  searchSplunkSdkReference,
} from '../../src/lib/splunkSdkReference.js';

const router = Router();

type OpenAIMessage = {
  role: string;
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
};

type ToolCallChunk = {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  index: number;
};

type AgentTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, vfs: VirtualFileSystem) => Promise<string>;
};

function validatePath(pathValue: string): string | null {
  const path = pathValue.replace(/\\/g, '/');
  const blocked = ['/etc/', '/usr/', '/var/', '/bin/', '/sbin/', '/tmp/', '/home/', '/root/'];
  if (blocked.some((p) => path.startsWith(p))) {
    return 'Security Error: access to system paths is not allowed.';
  }
  if (path.includes('..') || path.includes('.git/') || path.includes('node_modules/')) {
    return 'Security Error: path traversal or hidden/system folders are not allowed.';
  }
  return null;
}

function validateWritePath(pathValue: string): string | null {
  const err = validatePath(pathValue);
  if (err) return err;
  const path = pathValue.replace(/\\/g, '/');
  if (!(path.startsWith('package/') || path.startsWith('/package/') || path.includes('/package/'))) {
    return 'Security Error: write operations are only allowed within package/.';
  }
  return null;
}

const SPLUNK_HELP: Record<string, string> = {
  modular_inputs:
    'Use splunklib.modularinput Script/Scheme/Argument/Event for modular inputs. Prefer UCC helper modules in package/bin/*_helper.py.',
  validation:
    'Validate in two places: UI schema validators in globalConfig.json and runtime checks in validate_input/stream helper logic.',
  logging:
    'Use Splunk-friendly logging helpers, include actionable context, and never log secrets.',
  error_handling:
    'Wrap network/parse operations with retries and clear logs; fail per-stanza without crashing the whole input.',
  entity_types:
    'Common UCC field types: text, textarea, checkbox, singleSelect, multipleSelect, oauth, interval, index.',
  validators:
    'Common validators: string length, regex, number range, url/email/ipv4/date.',
};

const SERVER_TOOLS: AgentTool[] = [
  {
    name: 'list_files',
    description: 'List files from the current VFS, optionally filtered by directory prefix.',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Optional prefix (e.g. package/bin).' },
      },
    },
    execute: async (args, vfs) => {
      const dir = String(args.directory ?? '');
      const files = vfs.listAllFiles().map((f) => f.path).filter((p) => p.startsWith(dir));
      return JSON.stringify(files.slice(0, 500), null, 2);
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the current VFS.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    execute: async (args, vfs) => {
      const path = String(args.path ?? '');
      const err = validatePath(path);
      if (err) return err;
      const content = vfs.readFile(path);
      if (content === null) return `Error: File not found: ${path}`;
      return content.length > 20000
        ? `${content.slice(0, 20000)}\n\n... (truncated ${content.length - 20000} chars)`
        : content;
    },
  },
  {
    name: 'write_file',
    description: 'Write full content to a file under package/.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    execute: async (args, vfs) => {
      const path = String(args.path ?? '');
      const err = validateWritePath(path);
      if (err) return err;
      vfs.writeFile(path, String(args.content ?? ''), 'user');
      return `Successfully wrote to ${path}`;
    },
  },
  {
    name: 'create_file',
    description: 'Create a new file under package/; fails if file exists.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    execute: async (args, vfs) => {
      const path = String(args.path ?? '');
      const err = validateWritePath(path);
      if (err) return err;
      if (vfs.readFile(path) !== null) return `Error: ${path} already exists. Use apply_patch to edit it.`;
      vfs.writeFile(path, String(args.content ?? ''), 'user');
      return `Created ${path}`;
    },
  },
  {
    name: 'apply_patch',
    description: 'Apply unified-diff style patch envelope to one or more files.',
    parameters: {
      type: 'object',
      properties: { patch: { type: 'string' } },
      required: ['patch'],
    },
    execute: async (args, vfs) => {
      try {
        const parsed = parsePatch(String(args.patch ?? ''));
        for (const op of parsed.files) {
          const err = op.kind === 'delete' ? validatePath(op.path) : validateWritePath(op.path);
          if (err) return err;
        }
        const outcome = applyParsedPatch(parsed, (p) => vfs.readFile(p));
        for (const w of outcome.writes) vfs.writeFile(w.path, w.content, 'user');
        for (const d of outcome.deletes) vfs.delete(d);
        return `Patch applied: ${outcome.summary.join('; ')}`;
      } catch (e: unknown) {
        if (e instanceof PatchParseError || e instanceof PatchApplyError) {
          return `Patch error: ${e.message}`;
        }
        return `Patch error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    name: 'get_splunklib_help',
    description: 'Get concise Splunk/UCC implementation guidance by topic.',
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
    },
    execute: async (args) => {
      const topic = String(args.topic ?? '').trim();
      return SPLUNK_HELP[topic] ?? `No help entry for "${topic}".`;
    },
  },
  {
    name: 'get_splunk_sdk_reference',
    description: 'Search curated Splunk SDK/UCC symbol reference and signatures.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    execute: async (args) => {
      const query = String(args.query ?? '').trim();
      const limit = Math.max(1, Math.min(20, Number(args.limit ?? 8)));
      const matches = searchSplunkSdkReference(query, limit);
      if (!matches.length) return `No SDK reference matches found for "${query}".`;
      return `Splunk SDK reference matches for "${query}":\n\n${formatSplunkSdkEntries(matches)}`;
    },
  },
  {
    name: 'validate_ucc_conformance',
    description: 'Validate key UCC structure conventions against current VFS.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, vfs) => {
      const files = vfs.listAllFiles().map((f) => f.path);
      const globalConfigPath =
        files.find((p) => p.endsWith('/globalConfig.json')) || files.find((p) => p === 'globalConfig.json');
      if (!globalConfigPath) return 'UCC conformance: FAIL\n- [ERROR] Missing globalConfig.json';
      const appConfExists = files.some((p) => p.endsWith('/package/default/app.conf'));
      const hasAnyInputScript = files.some((p) => p.endsWith('.py') && p.includes('/package/bin/'));
      const errors: string[] = [];
      const warnings: string[] = [];
      if (!appConfExists) errors.push('Missing package/default/app.conf');
      if (!hasAnyInputScript) warnings.push('No Python scripts under package/bin detected');
      if (errors.length === 0 && warnings.length === 0) return 'UCC conformance: PASS. No issues detected.';
      return [
        `UCC conformance: ${errors.length ? 'FAIL' : 'PASS WITH WARNINGS'}`,
        ...errors.map((e) => `- [ERROR] ${e}`),
        ...warnings.map((w) => `- [WARNING] ${w}`),
      ].join('\n');
    },
  },
  {
    name: 'todo_write',
    description: 'Create/update the agent todo list for progress tracking.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              content: { type: 'string' },
              status: { type: 'string' },
            },
            required: ['id', 'content', 'status'],
          },
        },
        merge: { type: 'boolean' },
      },
      required: ['todos'],
    },
    execute: async (args) => {
      const incoming = Array.isArray(args.todos) ? (args.todos as Todo[]) : [];
      const merge = Boolean(args.merge);
      const next = merge ? sessionState.mergeTodos(incoming) : sessionState.setTodos(incoming);
      return `Todo list updated (${next.length} items).`;
    },
  },
  {
    name: 'record_decision',
    description: 'Persist an architectural/user decision for session consistency.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        question: { type: 'string' },
        decision: { type: 'string' },
        rationale: { type: 'string' },
      },
      required: ['id', 'question', 'decision'],
    },
    execute: async (args) => {
      const rec = sessionState.recordDecision({
        id: String(args.id),
        question: String(args.question),
        decision: String(args.decision),
        rationale: String(args.rationale ?? ''),
      });
      return `Decision recorded: (${rec.id}) ${rec.question} -> ${rec.decision}`;
    },
  },
  {
    name: 'read_memory',
    description: 'Read session memory by key or dump a summary.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' } },
    },
    execute: async (args) => {
      const key = String(args.key ?? '');
      if (key) {
        const val = sessionState.getMemory(key);
        return val ?? `No memory entry for "${key}".`;
      }
      return sessionState.summary();
    },
  },
  {
    name: 'write_memory',
    description: 'Write a key/value memory fact for this session.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['key', 'value'],
    },
    execute: async (args) => {
      const key = String(args.key ?? '');
      const value = String(args.value ?? '');
      if (!key) return 'Error: key is required.';
      sessionState.setMemory(key, value);
      return `Saved memory["${key}"] (${value.length} chars).`;
    },
  },
];

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

function toOpenAIToolFormat(tools: AgentTool[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
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

function openRouterApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_APIKEY;
}

async function readOpenRouterStream(
  response: globalThis.Response,
  onDelta: (content: string) => void,
): Promise<{ content: string; toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> }> {
  if (!response.body) throw new Error('OpenRouter response body is null.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls: Record<number, { id: string; function: { name: string; arguments: string } }> = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          onDelta(delta.content);
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls as ToolCallChunk[]) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = { id: tc.id || '', function: { name: '', arguments: '' } };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      } catch {
        // Ignore malformed stream chunks.
      }
    }
  }

  return {
    content,
    toolCalls: Object.values(toolCalls),
  };
}

async function callOpenRouter(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<globalThis.Response> {
  return fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://splunk.engineer',
      'X-Title': 'UCCBuilder',
    },
    body: JSON.stringify(body),
  });
}

/**
 * GET /api/ai/config
 * Returns AI configuration to the frontend.
 * If OPENROUTER_API_KEY (or legacy OPENROUTER_APIKEY) is set, the server will proxy requests.
 */
router.get('/ai/config', (_req: Request, res: Response) => {
  const serverManaged = !!openRouterApiKey();
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
    },
  });
});

/**
 * POST /api/ai/chat
 * Proxies chat completion requests to OpenRouter using the server-side API key.
 * Only available when OPENROUTER_API_KEY (or legacy OPENROUTER_APIKEY) is set.
 */
router.post('/ai/chat', async (req: Request, res: Response) => {
  const apiKey = openRouterApiKey();

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
  const apiKey = openRouterApiKey();
  if (!apiKey) {
    return res.status(403).json({
      error: 'Server-managed AI is not configured. Set OPENROUTER_API_KEY env variable.',
    });
  }

  const profile = resolveModelProfile();
  const {
    sessionId,
    model,
    system,
    messages,
    files,
    maxIterations,
  } = req.body ?? {};

  const initialMessages = Array.isArray(messages) ? (messages as OpenAIMessage[]) : [];
  const systemPrompt = typeof system === 'string' ? system : '';
  const sid = typeof sessionId === 'string' && sessionId.trim() ? sessionId : 'default';
  const selectedModel = typeof model === 'string' && model.trim() ? model : profile.models.executor;
  const plannerModel = profile.models.planner || selectedModel;
  const iterationsLimit = Number.isFinite(Number(maxIterations))
    ? Math.max(1, Math.min(20, Number(maxIterations)))
    : 12;

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

  try {
    loadSessionState(sid);

    // Planner seam: quick non-tool planning turn.
    const plannerResp = await callOpenRouter(apiKey, {
      model: plannerModel,
      messages: [
        {
          role: 'system',
          content:
            `${systemPrompt}\n\nYou are the planning phase. Produce a concise 3-6 step plan. ` +
            'Do not call tools; this is planning only.',
        },
        ...initialMessages,
      ],
      stream: false,
      max_tokens: 400,
    });
    const plannerJson = await plannerResp.json();
    const plannerText = plannerJson?.choices?.[0]?.message?.content || '';
    if (plannerText) writeSse(res, 'planner', { content: plannerText });

    const apiMessages: OpenAIMessage[] = [
      { role: 'system', content: systemPrompt },
      ...(plannerText
        ? [{ role: 'system', content: `Planner output (follow this unless contradicted by user):\n${plannerText}` }]
        : []),
      ...initialMessages,
    ];

    const openAiTools = toOpenAIToolFormat(SERVER_TOOLS);
    const toolMap = new Map(SERVER_TOOLS.map((t) => [t.name, t]));

    let keepGoing = true;
    let iterations = 0;
    while (keepGoing && iterations < iterationsLimit) {
      iterations++;
      writeSse(res, 'iteration', { index: iterations });

      const execResp = await callOpenRouter(apiKey, {
        model: selectedModel,
        messages: apiMessages,
        stream: true,
        max_tokens: 4096,
        tools: openAiTools,
      });

      if (!execResp.ok) {
        const err = await execResp.text();
        writeSse(res, 'error', { error: `Executor model error (${execResp.status}): ${err}` });
        break;
      }

      const { content, toolCalls } = await readOpenRouterStream(execResp, (delta) => {
        writeSse(res, 'assistant_delta', { content: delta });
      });

      apiMessages.push({
        role: 'assistant',
        content,
        tool_calls: toolCalls.length
          ? toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: tc.function,
            }))
          : undefined,
      });

      if (!toolCalls.length) {
        keepGoing = false;
        break;
      }

      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        const tool = toolMap.get(toolName);
        writeSse(res, 'tool_call', {
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
          writeSse(res, 'tool_result', { id: toolCall.id, name: toolName, content: message });
          continue;
        }

        let argsObj: Record<string, unknown> = {};
        try {
          argsObj = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
        } catch (e: unknown) {
          const message = `Invalid tool arguments for ${toolName}: ${e instanceof Error ? e.message : String(e)}`;
          apiMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: message,
          });
          writeSse(res, 'tool_result', { id: toolCall.id, name: toolName, content: message });
          continue;
        }

        try {
          const result = await tool.execute(argsObj, vfs);
          saveSessionState(sid);
          apiMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: result,
          });
          writeSse(res, 'tool_result', { id: toolCall.id, name: toolName, content: result });
          if (toolName === 'todo_write') {
            writeSse(res, 'todos', { items: sessionState.getTodos() });
          }
          if (toolName === 'record_decision') {
            writeSse(res, 'decisions', { items: sessionState.getDecisions() });
          }
        } catch (e: unknown) {
          const message = `Tool ${toolName} failed: ${e instanceof Error ? e.message : String(e)}`;
          apiMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: message,
          });
          writeSse(res, 'tool_result', { id: toolCall.id, name: toolName, content: message });
        }
      }
    }

    if (iterations >= iterationsLimit) {
      writeSse(res, 'warning', { message: `Reached max iterations (${iterationsLimit}).` });
    }

    saveSessionState(sid);
    writeSse(res, 'todos', { items: sessionState.getTodos() });
    writeSse(res, 'decisions', { items: sessionState.getDecisions() });
    writeSse(res, 'files', { files: vfs.getAllFiles() });
    writeSse(res, 'done', { ok: true });
    res.end();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    writeSse(res, 'error', { error: message });
    res.end();
  }
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
