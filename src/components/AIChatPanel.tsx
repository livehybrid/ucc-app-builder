import { useState, useRef, useCallback, useEffect } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { toolRegistry } from '../lib/ai/tools';
import { parseStream } from '../lib/ai/streamParser';
import { fetchWithRetry } from '../lib/ai/retry';
import type { VirtualFileSystem } from '../lib/vfs';
import styled from 'styled-components';
import SidePanel from '@splunk/react-ui/SidePanel';
import Button from '@splunk/react-ui/Button';
import Text from '@splunk/react-ui/Text';
import TextArea from '@splunk/react-ui/TextArea';
import Heading from '@splunk/react-ui/Heading';
import ControlGroup from '@splunk/react-ui/ControlGroup';
import Message from '@splunk/react-ui/Message';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import Select from '@splunk/react-ui/Select';
import Switch from '@splunk/react-ui/Switch';
import Modal from '@splunk/react-ui/Modal';
import { variables } from '@splunk/themes';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SYSTEM_PROMPT } from '../lib/ai/systemPrompt';

interface AIChatPanelProps {
  open: boolean;
  onRequestClose: () => void;
  vfs: VirtualFileSystem;
  onVfsChange?: () => void; // Callback to notify parent when VFS changes (e.g., to refresh Monaco)
  context?: {
    currentFile?: string;
    currentFileContent?: string;
    globalConfig?: string;
    errors?: string[];
    appName?: string; // The Splunk app name/ID (e.g., 'myapp1')
  };
  onBuildTrigger?: () => Promise<void> | void;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
  /** For tool results that concern a file (read_file): the file path, used to
      pick a syntax-highlighting language in the transcript. */
  toolPath?: string;
}

interface AgentTodo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

interface AgentDecision {
  id: string;
  question: string;
  decision: string;
  rationale?: string;
}

const PanelInner = styled.div<{ $width: number }>`
  width: ${(props) => props.$width}px;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: ${variables.backgroundColorDialog};
  position: relative;
`;

const ResizeHandle = styled.div<{ $isResizing: boolean }>`
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
  background: ${(props) => (props.$isResizing ? 'rgba(101, 166, 55, 0.5)' : 'transparent')};
  transition: background 0.2s;

  &:hover {
    background: rgba(101, 166, 55, 0.3);
  }

  &::after {
    content: '';
    position: absolute;
    left: 2px;
    top: 50%;
    transform: translateY(-50%);
    width: 2px;
    height: 40px;
    background: ${(props) => (props.$isResizing ? '#65A637' : 'rgba(255,255,255,0.2)')};
    border-radius: 2px;
  }
`;

const PanelHeader = styled.div`
  padding: 16px 20px;
  border-bottom: 1px solid ${variables.borderColor};
  display: flex;
  justify-content: space-between;
  align-items: center;
`;

const PanelBody = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const PanelFooter = styled.div`
  padding: 16px 20px;
  border-top: 1px solid ${variables.borderColor};
`;

const UsageBar = styled.div`
  margin-top: 8px;
  font-size: 0.78em;
  color: ${variables.contentColorMuted};
  font-variant-numeric: tabular-nums;
`;

type ModelPricing = { pricing?: { prompt: number; completion: number } };

/**
 * Render the token-usage line under the chat buttons: prompt/completion tokens
 * and, when the selected model's per-token pricing is known, an estimated cost.
 */
function renderUsage(
  usage: { promptTokens: number; completionTokens: number },
  modelId: string,
  models: Array<{ id: string } & ModelPricing>
): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  const total = usage.promptTokens + usage.completionTokens;
  let line = `Tokens — ↑ ${fmt(usage.promptTokens)} in · ↓ ${fmt(usage.completionTokens)} out · ${fmt(total)} total`;
  const pricing = models.find((m) => m.id === modelId)?.pricing;
  if (pricing) {
    const cost = usage.promptTokens * pricing.prompt + usage.completionTokens * pricing.completion;
    // Sub-cent costs need more precision than $0.00.
    const cost$ = cost >= 0.01 ? cost.toFixed(2) : cost.toFixed(4);
    line += ` · ~$${cost$}`;
  } else {
    line += ' · cost n/a for this model';
  }
  return line;
}

const SettingsSection = styled.div`
  /* Settings takes over the whole panel body (the chat is hidden while it is
     open) — a half-overlay invited users to keep chatting with settings up.
     Scrolls internally; an explicit Done button in the footer returns to chat. */
  flex: 1;
  overflow-y: auto;
  padding: 12px 0;
`;

const MessageBubble = styled.div<{ $role: 'user' | 'assistant' | 'system' | 'tool' }>`
  padding: 12px 16px;
  border-radius: 8px;
  max-width: 90%;
  align-self: ${(props) => (props.$role === 'user' ? 'flex-end' : 'flex-start')};
  background: ${(props) =>
    props.$role === 'user'
      ? 'rgba(101, 166, 55, 0.2)'
      : props.$role === 'system'
        ? 'rgba(245, 130, 32, 0.15)'
        : props.$role === 'tool'
          ? 'rgba(0, 0, 0, 0.2)'
          : 'rgba(255, 255, 255, 0.05)'};
  border: 1px solid
    ${(props) =>
      props.$role === 'user'
        ? 'rgba(101, 166, 55, 0.3)'
        : props.$role === 'system'
          ? 'rgba(245, 130, 32, 0.3)'
          : props.$role === 'tool'
            ? 'rgba(255, 255, 255, 0.1)'
            : variables.borderColor};
  font-family: ${(props) => (props.$role === 'tool' ? 'monospace' : 'inherit')};
  font-size: ${(props) => (props.$role === 'tool' ? '0.8rem' : '0.875rem')};
  line-height: 1.5;
  word-break: break-word;
`;

/** Tool-call result header + loop-trace styling (shared with LoopPanel's language). */
const ToolHeader = styled.div<{ $verify?: boolean }>`
  font-weight: 700;
  font-family: inherit;
  font-size: 0.78rem;
  margin-bottom: 6px;
  color: ${(props) => (props.$verify ? '#5bc0de' : variables.contentColorMuted)};
  text-transform: uppercase;
  letter-spacing: 0.04em;
`;

const TraceLine = styled.div<{ $accent: string }>`
  border-left: 3px solid ${(props) => props.$accent};
  padding: 2px 8px;
  margin: 2px 0;
  background: rgba(255, 255, 255, 0.03);
  white-space: pre-wrap;
`;

function traceAccent(line: string): string {
  if (/CLEAN|\bclean\b|✅/.test(line)) return '#5cb85c';
  if (/build_error|exhausted|fix_skipped|NOT clean|❌|failure/i.test(line)) return '#d9534f';
  if (/\bfix\b|🩹/.test(line)) return '#f0ad4e';
  if (/inspect|🔎/.test(line)) return '#5bc0de';
  return 'rgba(255,255,255,0.15)';
}

/** Map a file extension to a Monaco language id for transcript highlighting. */
function languageForPath(path?: string): string {
  const ext = (path ?? '').split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'json':
      return 'json';
    case 'py':
      return 'python';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'xml':
      return 'xml';
    case 'md':
      return 'markdown';
    case 'html':
      return 'html';
    case 'css':
      return 'css';
    case 'conf':
    case 'meta':
    case 'ini':
    case 'manifest':
      return 'ini';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'sh':
      return 'shell';
    default:
      return 'plaintext';
  }
}

const TODO_STATUS_ICON: Record<string, string> = {
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
  cancelled: '🚫',
};

/**
 * Render a tool result. For build_and_inspect we render the loop trace with the
 * same colour language as LoopPanel so the agent's self-correcting loop is
 * visible inline in the chat (the unified experience). read_file results are
 * shown in a read-only syntax-highlighted viewer; todo_write as a checklist.
 */
function ToolMessage({ name, content, path }: { name?: string; content: string; path?: string }) {
  const isVerify = name === 'build_and_inspect';
  if (isVerify) {
    return (
      <div>
        <ToolHeader $verify>build &amp; inspect · self-correcting loop</ToolHeader>
        {content.split('\n').map((line, i) =>
          line.trim() ? (
            <TraceLine key={i} $accent={traceAccent(line)}>
              {line}
            </TraceLine>
          ) : null
        )}
      </div>
    );
  }

  // todo_write / read_memory → render any "[status] item" lines as a checklist.
  // read_memory dumps a "Todos:\n  [status] item" block (plus Decisions/Memory
  // sections); render the status lines with icons and keep other lines as text so
  // the dump no longer reads as one run-on line.
  if ((name === 'todo_write' || name === 'read_memory') && !content.startsWith('Error')) {
    const lines = content.split('\n');
    const hasChecklist = lines.some((l) =>
      /^\s*\[(pending|in_progress|completed|cancelled)\s*\]/.test(l)
    );
    if (hasChecklist) {
      return (
        <div>
          {name && <ToolHeader>{name === 'todo_write' ? 'todo list' : 'memory'}</ToolHeader>}
          {lines.map((line, i) => {
            const m = line.match(/^\s*\[(pending|in_progress|completed|cancelled)\s*\]\s*(.*)$/);
            if (m) {
              const done = m[1] === 'completed' || m[1] === 'cancelled';
              return (
                <div
                  key={i}
                  style={{
                    padding: '2px 0',
                    opacity: done ? 0.6 : 1,
                    textDecoration: m[1] === 'cancelled' ? 'line-through' : undefined,
                  }}
                >
                  {TODO_STATUS_ICON[m[1]] ?? '⬜'} {m[2]}
                </div>
              );
            }
            // Section headers / other lines (e.g. "Todos:", "Decisions:") as-is.
            return line.trim() ? <div key={i}>{line}</div> : <div key={i}>&nbsp;</div>;
          })}
        </div>
      );
    }
  }

  // read_file (success) → syntax-highlighted read-only viewer in the file's language.
  if (name === 'read_file' && !content.startsWith('Error')) {
    const lineCount = content.split('\n').length;
    const height = Math.min(320, lineCount * 19 + 14);
    return (
      <div style={{ width: '100%' }}>
        <ToolHeader>read file{path ? ` · ${path}` : ''}</ToolHeader>
        <div
          style={{
            height,
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 4,
            overflow: 'hidden',
          }}
        >
          <Editor
            value={content}
            language={languageForPath(path)}
            theme="vs-dark"
            options={{
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              lineNumbers: 'on',
              fontSize: 12,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              contextmenu: false,
              automaticLayout: true,
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      {name && <ToolHeader>{name.replace(/_/g, ' ')}</ToolHeader>}
      {/* Tool results are plain text and frequently multi-line (e.g. read_memory's
          todo/decision dump). Preserve newlines so they don't collapse into one
          run-on line, and wrap long lines. */}
      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content}</div>
    </div>
  );
}

const MarkdownContent = styled.div`
  /* Reset markdown styles for chat */
  p {
    margin: 0 0 0.5em 0;
  }
  p:last-child {
    margin-bottom: 0;
  }

  /* Code styling */
  code {
    background: rgba(0, 0, 0, 0.3);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 0.85em;
  }

  pre {
    background: rgba(0, 0, 0, 0.4);
    padding: 12px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 8px 0;
  }

  pre code {
    background: none;
    padding: 0;
    font-size: 0.8em;
  }

  /* Lists */
  ul,
  ol {
    margin: 8px 0;
    padding-left: 24px;
  }

  /* Tables (GFM) */
  table {
    border-collapse: collapse;
    margin: 8px 0;
    width: 100%;
    font-size: 0.85em;
  }
  th,
  td {
    border: 1px solid rgba(255, 255, 255, 0.2);
    padding: 4px 8px;
    text-align: left;
  }
  th {
    background: rgba(0, 0, 0, 0.3);
    font-weight: 600;
  }
  tr:nth-child(even) td {
    background: rgba(0, 0, 0, 0.15);
  }

  li {
    margin: 4px 0;
  }

  /* Headers */
  h1,
  h2,
  h3,
  h4 {
    margin: 12px 0 8px 0;
    font-weight: 600;
  }
  h1 {
    font-size: 1.2em;
  }
  h2 {
    font-size: 1.1em;
  }
  h3,
  h4 {
    font-size: 1em;
  }

  /* Links */
  a {
    color: #65a637;
    text-decoration: underline;
  }

  /* Blockquotes */
  blockquote {
    border-left: 3px solid rgba(101, 166, 55, 0.5);
    margin: 8px 0;
    padding-left: 12px;
    color: #9b9ea3;
  }
`;

const EmptyState = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: #9b9ea3;
  gap: 12px;
`;

const API_KEY_STORAGE = 'splunk-app-builder-openrouter-key';
const MODEL_STORAGE = 'splunk-app-builder-ai-model';
const AUTOACCEPT_STORAGE = 'splunk-app-builder-ai-autoaccept';
const CHAT_HISTORY_STORAGE = 'splunk-app-builder-chat-history';
const PANEL_WIDTH_STORAGE = 'splunk-app-builder-panel-width';
const AGENT_SESSION_KEY = 'ucc-agent-session-id';

// Popular coding-capable models with tool support
const AVAILABLE_MODELS = [
  { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6 (Recommended)', provider: 'Moonshot' },
  { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', provider: 'Anthropic' },
  { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet', provider: 'Anthropic' },
  { id: 'openai/gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
  { id: 'openai/gpt-4-turbo', label: 'GPT-4 Turbo', provider: 'OpenAI' },
  { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash', provider: 'Google' },
  { id: 'google/gemini-pro-1.5', label: 'Gemini Pro 1.5', provider: 'Google' },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3', provider: 'DeepSeek' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', provider: 'Meta' },
];

interface AIConfig {
  serverManaged: boolean;
  defaultModel: string;
  profile?: string;
  models?: {
    planner?: string;
    executor?: string;
    verifier?: string;
  };
  notes?: string[];
  capabilities?: {
    dockerToolsEnabled?: boolean;
    browserCheckEnabled?: boolean;
    localDocsIndexEnabled?: boolean;
    mcpGroundingEnabled?: boolean;
  };
  agent?: {
    maxIterations?: number;
    maxIterationsMin?: number;
    maxIterationsMax?: number;
    inspectMaxIterations?: number;
    noProgressLimit?: number;
  };
  toolPolicy?: {
    policy?: Record<string, ToolPolicy>;
    askTools?: string[];
    mcpGroundingAuto?: boolean;
  };
}

/** Tool-approval policy, mirrored from server/services/toolPolicy.ts. */
type ToolPolicy = 'auto' | 'ask' | 'deny';

const TOOL_POLICY_STORAGE = 'splunk-app-builder-ai-tool-policy';

/**
 * Browser-side external-access tools (the in-process registry equivalents of the
 * server's `ask` defaults). These reach outside the VFS sandbox, so they default
 * to first-use approval client-side too.
 */
const CLIENT_ASK_TOOLS = [
  'install_to_splunk_docker',
  'browser_check',
  'run_ucc_gen',
  'run_appinspect',
];

const MAX_ITER_STORAGE = 'splunk-app-builder-ai-max-iterations';
const MAX_ITER_MIN = 1;
const MAX_ITER_MAX = 20;

/** The user's decision on a pending approval card. */
type ApprovalDecision = 'approve' | 'approve_session' | 'deny';

// Pending tool approval state type
interface PendingApproval {
  toolName: string;
  args: Record<string, unknown>;
  resolve: (decision: ApprovalDecision) => void;
  existingContent?: string;
  /** A one-line reason shown on the approval card. */
  reason?: string;
}

export function AIChatPanel({
  open,
  onRequestClose,
  context,
  vfs,
  onVfsChange,
  onBuildTrigger,
}: AIChatPanelProps) {
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem(API_KEY_STORAGE) || '');
  const [selectedModel, setSelectedModel] = useState(() => {
    const saved = localStorage.getItem(MODEL_STORAGE);
    // Migration: the old default 'moonshotai/kimi-k2' was MISLABELLED as K2.6 in
    // the picker — anyone carrying it actually wanted (and saw) K2.6.
    if (!saved || saved === 'moonshotai/kimi-k2') return 'moonshotai/kimi-k2.6';
    return saved;
  });
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null);
  // Max agent iterations. Seeded from the server's env-configurable default
  // (/api/ai/config) unless the user has overridden it locally. Clamped [1,20].
  const [maxIterations, setMaxIterations] = useState<number>(() => {
    const saved = Number(localStorage.getItem(MAX_ITER_STORAGE));
    return Number.isFinite(saved) && saved >= MAX_ITER_MIN && saved <= MAX_ITER_MAX ? saved : 12;
  });

  const saveMaxIterations = (value: number) => {
    const clamped = Math.max(MAX_ITER_MIN, Math.min(MAX_ITER_MAX, Math.round(value)));
    setMaxIterations(clamped);
    localStorage.setItem(MAX_ITER_STORAGE, String(clamped));
  };

  // Live model catalog from OpenRouter (tool-calling models, server-cached).
  // Falls back to the static AVAILABLE_MODELS list when unavailable.
  const [remoteModels, setRemoteModels] = useState<
    Array<{
      id: string;
      label: string;
      provider: string;
      contextLength: number;
      pricing?: { prompt: number; completion: number };
    }>
  >([]);
  // Cumulative token usage for the current message turn (reset on each send).
  const [usage, setUsage] = useState<{ promptTokens: number; completionTokens: number } | null>(
    null
  );
  useEffect(() => {
    fetch('/api/ai/models')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data?.models) && data.models.length) setRemoteModels(data.models);
      })
      .catch(() => {
        // Keep the static fallback list.
      });
  }, []);

  // Detect server-managed AI mode on mount
  useEffect(() => {
    fetch('/api/ai/config')
      .then((res) => res.json())
      .then((config: AIConfig) => {
        setAiConfig(config);
        if (config.serverManaged && !localStorage.getItem(MODEL_STORAGE)) {
          setSelectedModel(config.defaultModel);
        }
        // Seed the iteration control from the server default unless the user set one.
        if (config.agent?.maxIterations && !localStorage.getItem(MAX_ITER_STORAGE)) {
          const d = config.agent.maxIterations;
          if (d >= MAX_ITER_MIN && d <= MAX_ITER_MAX) setMaxIterations(d);
        }
      })
      .catch(() => {
        // Server not available, fall back to client mode
        setAiConfig({ serverManaged: false, defaultModel: 'moonshotai/kimi-k2.6' });
      });
  }, []);
  const [useCustomModel, setUseCustomModel] = useState(false);
  const [customModelId, setCustomModelId] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  // Chat history - initialized from localStorage
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const saved = localStorage.getItem(CHAT_HISTORY_STORAGE);
      if (saved) {
        const parsed = JSON.parse(saved);
        return parsed.map(
          (m: {
            role: string;
            content: string;
            timestamp: string;
            tool_calls?: unknown[];
            tool_call_id?: string;
            name?: string;
          }) => ({ ...m, timestamp: new Date(m.timestamp) })
        );
      }
    } catch (e) {
      console.error('Failed to load chat history:', e);
    }
    return [];
  });

  // Track current app ID to clear chat when switching apps
  const [currentAppId, setCurrentAppId] = useState<string>('');

  // Effect to clear chat when app context changes
  useEffect(() => {
    if (context?.globalConfig) {
      try {
        const config = JSON.parse(context.globalConfig);
        const appId =
          config.meta?.id || config.meta?.name?.toLowerCase().replace(/[^a-z0-9]/g, '_');

        if (appId && currentAppId && appId !== currentAppId) {
          // App changed, clear chat
          setMessages([]);
        }

        if (appId) {
          setCurrentAppId(appId);
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }, [context?.globalConfig, currentAppId]);

  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Abort handle for the in-flight agent run. Aborting the fetch closes the SSE
  // stream, which the server detects and cancels the run (and its LLM spend).
  const runAbortRef = useRef<AbortController | null>(null);
  // Args of in-flight server tool calls, keyed by call id, so the matching
  // tool_result can be rendered with file context (e.g. read_file path →
  // syntax-highlighting language).
  const toolCallArgsRef = useRef<Record<string, Record<string, unknown>>>({});
  // After "Reached max iterations" the user may grant another batch.
  const [offerContinue, setOfferContinue] = useState(false);
  const [planText, setPlanText] = useState('');
  const [todos, setTodos] = useState<AgentTodo[]>([]);
  const [decisions, setDecisions] = useState<AgentDecision[]>([]);

  // Auto-accept toggle (persisted to localStorage)
  const [autoAccept, setAutoAccept] = useState(
    () => localStorage.getItem(AUTOACCEPT_STORAGE) === 'true'
  );

  // Per-tool approval policy overrides (Settings UI). Persisted to localStorage and
  // sent with each server request so the server honours the user's choices.
  const [toolPolicyOverrides, setToolPolicyOverrides] = useState<Record<string, ToolPolicy>>(() => {
    try {
      const saved = localStorage.getItem(TOOL_POLICY_STORAGE);
      if (saved) return JSON.parse(saved) as Record<string, ToolPolicy>;
    } catch {
      // ignore
    }
    return {};
  });

  // Tools approved for the rest of THIS session (in-process, browser fallback loop).
  const sessionApprovedRef = useRef<Set<string>>(new Set());

  const saveToolPolicyOverride = (tool: string, policy: ToolPolicy) => {
    setToolPolicyOverrides((prev) => {
      const next = { ...prev, [tool]: policy };
      localStorage.setItem(TOOL_POLICY_STORAGE, JSON.stringify(next));
      return next;
    });
  };

  /**
   * Resolve a tool's effective policy client-side: per-request override wins,
   * else the server's effective policy (from /api/ai/config), else a built-in
   * default (external-access client tools → `ask`, everything else → `auto`).
   */
  const resolveClientPolicy = (tool: string): ToolPolicy => {
    if (toolPolicyOverrides[tool]) return toolPolicyOverrides[tool];
    const fromServer = aiConfig?.toolPolicy?.policy?.[tool];
    if (fromServer) return fromServer;
    return CLIENT_ASK_TOOLS.includes(tool) ? 'ask' : 'auto';
  };

  // Panel width - resizable and persisted
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem(PANEL_WIDTH_STORAGE);
    return saved ? parseInt(saved, 10) : 600;
  });
  const [isResizing, setIsResizing] = useState(false);

  // Approval modal state - only used when autoAccept is false
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const modalReturnRef = useRef(null);

  // Get the active model (custom or selected)
  const activeModel = useCustomModel && customModelId.trim() ? customModelId.trim() : selectedModel;

  // Persist chat history to localStorage whenever messages change
  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(CHAT_HISTORY_STORAGE, JSON.stringify(messages));
    }
  }, [messages]);

  // Persist panel width
  useEffect(() => {
    localStorage.setItem(PANEL_WIDTH_STORAGE, panelWidth.toString());
  }, [panelWidth]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const saveApiKey = (key: string) => {
    setApiKey(key);
    if (key) {
      sessionStorage.setItem(API_KEY_STORAGE, key);
    } else {
      sessionStorage.removeItem(API_KEY_STORAGE);
    }
  };

  const saveModel = (modelId: string) => {
    setSelectedModel(modelId);
    localStorage.setItem(MODEL_STORAGE, modelId);
  };

  const saveAutoAccept = (enabled: boolean) => {
    setAutoAccept(enabled);
    localStorage.setItem(AUTOACCEPT_STORAGE, enabled ? 'true' : 'false');
  };

  const getSessionId = (): string => {
    let id = window.localStorage.getItem(AGENT_SESSION_KEY);
    if (!id) {
      id = `sess_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
      window.localStorage.setItem(AGENT_SESSION_KEY, id);
    }
    return id;
  };

  // Resize handlers for draggable panel width
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      // Calculate new width based on mouse position (panel is on the right)
      const newWidth = window.innerWidth - moveEvent.clientX;
      // Constrain between min 400px and max 900px
      setPanelWidth(Math.max(400, Math.min(900, newWidth)));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  // Clear chat (also clears localStorage)
  const clearChat = useCallback(() => {
    setMessages([]);
    setError(null);
    setPlanText('');
    setTodos([]);
    setDecisions([]);
    setOfferContinue(false);
    localStorage.removeItem(CHAT_HISTORY_STORAGE);
    // Rotate the agent session id too: the server keeps per-session memory
    // (todos, decisions, approvals) keyed by it — "clear chat" means a genuinely
    // fresh agent, not the same memory under an empty transcript.
    window.localStorage.removeItem(AGENT_SESSION_KEY);
    sessionApprovedRef.current = new Set();
  }, []);

  // App-level "start fresh" (New App over leftover files) also clears the
  // agent: chat history, session memory, approvals.
  useEffect(() => {
    window.addEventListener('ucc:fresh-start', clearChat);
    return () => window.removeEventListener('ucc:fresh-start', clearChat);
  }, [clearChat]);

  /**
   * Gate a tool action client-side, mirroring the server's policy + session-memory
   * handshake. Returns true to run the tool, false to refuse it. `deny`-policy tools
   * are refused outright; `ask` tools prompt on FIRST use and, once approved for the
   * session, run automatically thereafter; `auto` (and write_file diff review) run
   * subject only to the auto-accept toggle.
   */
  const requestApproval = (toolName: string, args: Record<string, unknown>): Promise<boolean> => {
    const policy = resolveClientPolicy(toolName);

    // Denied by policy → never run.
    if (policy === 'deny') {
      return Promise.resolve(false);
    }

    // Already approved for this session → run automatically (remembered).
    if (sessionApprovedRef.current.has(toolName)) {
      return Promise.resolve(true);
    }

    // Auto-accept short-circuits everything except a deny policy.
    if (autoAccept) {
      return Promise.resolve(true);
    }

    // `auto` policy non-write tools need no prompt under normal accept flow; only
    // file writes (diff review) and `ask` tools raise a card.
    if (policy === 'auto' && toolName !== 'write_file') {
      return Promise.resolve(true);
    }

    // Get existing file content for diff view if this is a write operation
    let existingContent: string | undefined;
    if (toolName === 'write_file' && args.path) {
      try {
        const content = vfs.readFile(args.path as string);
        existingContent = content || undefined;
      } catch {
        existingContent = undefined; // File doesn't exist yet
      }
    }

    const reason =
      policy === 'ask'
        ? `"${toolName}" has external access (it can reach outside this build sandbox). Approve once, approve for the session, or deny.`
        : undefined;

    // Show the approval card and wait for the user's decision.
    return new Promise<boolean>((resolve) => {
      setPendingApproval({
        toolName,
        args,
        existingContent,
        reason,
        resolve: (decision) => {
          if (decision === 'approve_session') {
            sessionApprovedRef.current.add(toolName);
            resolve(true);
          } else if (decision === 'approve') {
            resolve(true);
          } else {
            resolve(false);
          }
        },
      });
    });
  };

  const handleApprovalResponse = (decision: ApprovalDecision) => {
    if (pendingApproval) {
      pendingApproval.resolve(decision);
      setPendingApproval(null);
    }
  };

  const buildSystemMessage = (): string => {
    // Security guardrails and role definition
    let system = SYSTEM_PROMPT;

    // Add current context
    if (context?.appName) {
      system += `\n\n## App Structure\n**App Name:** ${context.appName}\n`;
      system += `**Important:** All file paths in this project are relative to the virtual file system root.\n`;
      system += `The standard UCC file structure is:\n`;
      system += `- \`globalConfig.json\` - Main UCC configuration (at root)\n`;
      system += `- \`package/bin/\` - Python helper scripts (e.g., \`input1_helper.py\`)\n`;
      system += `- \`package/lib/\` - Shared Python libraries\n`;
      system += `- \`package/default/\` - Default .conf files\n\n`;
      system += `**CRITICAL:** When asked to modify files like \`input1_helper.py\`, use the EXACT path from the "Project Files" list below. Do NOT create nested folders or guess paths.`;
    }
    if (context?.currentFile) {
      system += `\n\n## Current Context\nUser is editing: ${context.currentFile}`;
    }
    if (context?.currentFileContent) {
      system += `\n\nFile content:\n\`\`\`\n${context.currentFileContent.substring(0, 4000)}\n\`\`\``;
    }
    if (context?.globalConfig) {
      try {
        const config = JSON.parse(context.globalConfig);
        let summary = '\n\n## Existing Components (READ ONLY)\n';

        // Summarize Inputs
        if (config.pages?.inputs?.services?.length > 0) {
          summary += '**Modular Inputs:**\n';
          config.pages.inputs.services.forEach((s: { name: string; title: string }) => {
            summary += `- "${s.name}" (${s.title})\n`;
          });
        }

        // Summarize Alerts
        if (config.alerts?.length > 0) {
          summary += '**Alert Actions:**\n';
          config.alerts.forEach((a: { name: string; label: string }) => {
            summary += `- "${a.name}" (${a.label})\n`;
          });
        }

        // Summarize Accounts
        const accountTabs = config.pages?.configuration?.tabs?.filter(
          (t: { name: string; title: string }) => t.name === 'account' || t.name === 'aws_account'
        );
        if (accountTabs?.length > 0) {
          summary += '**Configuration Tabs:**\n';
          accountTabs.forEach((t: { name: string; title: string }) => {
            summary += `- "${t.name}" (${t.title})\n`;
          });
        }

        system += summary;
        system += `\n**CRITICAL INSTRUCTION:**\nBefore suggesting NEW inputs or alerts, you MUST check the list above.\n- If a similar component exists, ASK the user: "I see an existing input '${config.pages.inputs.services[0]?.name}'. Should I use that one or create a new one?"\n- DO NOT blindly create new inputs if one might already exist.\n- If you create a new input, use a unique name that doesn't conflict.`;
      } catch (e) {
        // Fallback if parse fails
      }

      system += `\n\n## Current globalConfig.json\nThis file defines all inputs, accounts, and settings for the app. Study it to understand existing components:\n\`\`\`json\n${context.globalConfig.substring(0, 8000)}\n\`\`\``;
    }
    if (context?.errors && context.errors.length > 0) {
      system += `\n\nCurrent errors:\n${context.errors.join('\n')}`;
    }

    if (aiConfig?.capabilities) {
      const dockerEnabled = Boolean(aiConfig.capabilities.dockerToolsEnabled);
      const browserEnabled = Boolean(aiConfig.capabilities.browserCheckEnabled);
      const docsEnabled = Boolean(aiConfig.capabilities.localDocsIndexEnabled);
      system += `\n\n## Tool Capability Flags`;
      system += `\n- Docker install tooling: ${dockerEnabled ? 'ENABLED' : 'DISABLED'}`;
      system += `\n- Browser-check tooling: ${browserEnabled ? 'ENABLED' : 'DISABLED'}`;
      system += `\n- Local docs index: ${docsEnabled ? 'ENABLED' : 'DISABLED'}`;
      if (!dockerEnabled) {
        system += `\n- Do NOT call install_to_splunk_docker when disabled.`;
      }
      if (!browserEnabled) {
        system += `\n- Do NOT call browser_check when disabled.`;
      }
      if (!docsEnabled) {
        system += `\n- consult_documentation may rely on external context service only.`;
      }
    }

    const files = vfs.listAllFiles().map((f) => f.path);
    if (files.length > 0) {
      system += `\n\n## Project Files (use these EXACT paths)\n${files.join('\n')}`;
    }

    return system;
  };

  const applyServerFiles = (files: Array<{ path: string; content: string }>) => {
    const snapshot = {
      files: files.map((f) => ({
        path: f.path,
        content: f.content,
        source: 'user' as const,
      })),
    };
    vfs.fromSnapshot(snapshot);
    onVfsChange?.();
  };

  const applyTodoPayload = (payload: unknown) => {
    if (!Array.isArray(payload)) return;
    const items: AgentTodo[] = payload
      .map((item) => ({
        id: String((item as Record<string, unknown>).id || ''),
        content: String((item as Record<string, unknown>).content || ''),
        status: String(
          (item as Record<string, unknown>).status || 'pending'
        ) as AgentTodo['status'],
      }))
      .filter((item) => item.id && item.content);
    if (items.length) setTodos(items);
  };

  const applyDecisionPayload = (payload: unknown) => {
    if (!Array.isArray(payload)) return;
    const items: AgentDecision[] = payload
      .map((item) => ({
        id: String((item as Record<string, unknown>).id || ''),
        question: String((item as Record<string, unknown>).question || ''),
        decision: String((item as Record<string, unknown>).decision || ''),
        rationale: String((item as Record<string, unknown>).rationale || ''),
      }))
      .filter((item) => item.id && item.question && item.decision);
    if (items.length) setDecisions(items);
  };

  const streamServerAgentLoop = async (payload: {
    sessionId: string;
    model: string;
    system: string;
    messages: Array<{
      role: string;
      content: string;
      tool_calls?: unknown[];
      tool_call_id?: string;
      name?: string;
    }>;
    files: Array<{ path: string; content: string }>;
    maxIterations?: number;
    toolPolicy?: Record<string, ToolPolicy>;
  }) => {
    const response = await fetch('/api/ai/agent/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: runAbortRef.current?.signal,
    });
    if (!response.ok) {
      throw new Error(`Agent stream error: ${response.status}`);
    }
    if (!response.body) {
      throw new Error('Agent stream missing response body.');
    }

    let assistantContent = '';
    let hasAssistantMessage = false;
    let eventName = 'message';
    const pendingData: string[] = [];
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';

    const dispatchEvent = (name: string, dataText: string) => {
      let parsed: Record<string, unknown> = {};
      if (dataText) {
        try {
          parsed = JSON.parse(dataText);
        } catch {
          parsed = { raw: dataText };
        }
      }

      if (name === 'iteration') {
        // New executor turn → new assistant bubble. Without this reset the
        // accumulated text of EVERY previous turn was re-posted after each tool
        // result, snowballing duplicate paragraphs down the transcript.
        assistantContent = '';
        hasAssistantMessage = false;
        return;
      }

      if (name === 'planner' && parsed.content) {
        setPlanText(String(parsed.content));
        setMessages((prev) => [
          ...prev,
          {
            role: 'system',
            content: `Plan:\n${String(parsed.content)}`,
            timestamp: new Date(),
          },
        ]);
        return;
      }

      if (name === 'tool_call') {
        const toolName = String(parsed.name || '');
        let parsedArgs: unknown = undefined;
        try {
          parsedArgs = JSON.parse(String(parsed.arguments || '{}'));
        } catch {
          parsedArgs = undefined;
        }
        if (parsed.id && parsedArgs && typeof parsedArgs === 'object') {
          toolCallArgsRef.current[String(parsed.id)] = parsedArgs as Record<string, unknown>;
        }
        if (
          toolName === 'todo_write' &&
          parsedArgs &&
          (parsedArgs as Record<string, unknown>).todos
        ) {
          applyTodoPayload((parsedArgs as Record<string, unknown>).todos);
        }
        if (toolName === 'record_decision' && parsedArgs) {
          const d = parsedArgs as Record<string, unknown>;
          if (d.id && d.question && d.decision) {
            setDecisions((prev) => {
              const next = prev.filter((x) => x.id !== String(d.id));
              next.push({
                id: String(d.id),
                question: String(d.question),
                decision: String(d.decision),
                rationale: String(d.rationale || ''),
              });
              return next;
            });
          }
        }
        return;
      }

      if (name === 'assistant_delta' && parsed.content) {
        assistantContent += String(parsed.content);
        setMessages((prev) => {
          if (!hasAssistantMessage) {
            hasAssistantMessage = true;
            return [
              ...prev,
              { role: 'assistant', content: assistantContent, timestamp: new Date() },
            ];
          }
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant') {
            return [...prev.slice(0, -1), { ...last, content: assistantContent }];
          }
          return [...prev, { role: 'assistant', content: assistantContent, timestamp: new Date() }];
        });
        return;
      }

      if (name === 'tool_result') {
        const callArgs = toolCallArgsRef.current[String(parsed.id || '')];
        setMessages((prev) => [
          ...prev,
          {
            role: 'tool',
            content: String(parsed.content || ''),
            name: String(parsed.name || ''),
            tool_call_id: String(parsed.id || ''),
            toolPath: typeof callArgs?.path === 'string' ? callArgs.path : undefined,
            timestamp: new Date(),
          },
        ]);
        return;
      }

      if (name === 'approval_request' && parsed.approvalId && parsed.tool) {
        const approvalId = String(parsed.approvalId);
        const toolName = String(parsed.tool);
        const args = (parsed.args ?? {}) as Record<string, unknown>;
        const reason =
          typeof parsed.reason === 'string'
            ? parsed.reason
            : `"${toolName}" has external access. Approve once, approve for the session, or deny.`;
        // The server is paused AWAITing POST /api/ai/agent/approve. Render the card;
        // its decision is POSTed back, which resumes the server-side run.
        setPendingApproval({
          toolName,
          args,
          reason,
          resolve: (decision: ApprovalDecision) => {
            void fetch('/api/ai/agent/approve', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ approvalId, decision }),
            }).catch(() => {
              // The stream will surface an error / timeout if this fails.
            });
          },
        });
        return;
      }

      if (name === 'approval_timeout') {
        // The server already treated this as a deny; just close any open card.
        setPendingApproval((prev) =>
          prev && prev.toolName === String(parsed.tool || prev.toolName) ? null : prev
        );
        setMessages((prev) => [
          ...prev,
          {
            role: 'system',
            content: `Approval for "${String(parsed.tool || 'tool')}" timed out — the agent will proceed without it.`,
            timestamp: new Date(),
          },
        ]);
        return;
      }

      if (name === 'warning' && parsed.message) {
        let message = String(parsed.message);
        if (/reached max iterations/i.test(message)) {
          // Offer the user another batch rather than a dead end.
          setOfferContinue(true);
          message += ' Click "Continue" below to let the agent keep going.';
        }
        setMessages((prev) => [
          ...prev,
          { role: 'system', content: message, timestamp: new Date() },
        ]);
        return;
      }

      if (name === 'files' && Array.isArray(parsed.files)) {
        applyServerFiles(parsed.files as Array<{ path: string; content: string }>);
        return;
      }

      if (name === 'usage') {
        setUsage({
          promptTokens: Number(parsed.promptTokens ?? 0),
          completionTokens: Number(parsed.completionTokens ?? 0),
        });
        return;
      }

      if (name === 'todos' && Array.isArray(parsed.items)) {
        applyTodoPayload(parsed.items);
        return;
      }

      if (name === 'decisions' && Array.isArray(parsed.items)) {
        applyDecisionPayload(parsed.items);
        return;
      }

      if (name === 'error' && parsed.error) {
        throw new Error(String(parsed.error));
      }
    };

    const flushEvent = () => {
      const data = pendingData.join('\n');
      dispatchEvent(eventName, data);
      eventName = 'message';
      pendingData.length = 0;
    };

    let streamComplete = false;
    while (!streamComplete) {
      const { done, value } = await reader.read();
      if (done) {
        streamComplete = true;
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (!line) {
          flushEvent();
          continue;
        }
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          pendingData.push(line.slice(5).trim());
        }
      }
    }

    if (pendingData.length > 0) flushEvent();
  };

  const sendMessage = async (overrideText?: string) => {
    const text = (overrideText ?? inputValue).trim();
    if (!text || isLoading) return;

    const isServerManaged = aiConfig?.serverManaged ?? false;

    // When embedded in Splunk, every /api call is forwarded by a persistent REST
    // proxy that must return its whole payload at once — it cannot stream SSE
    // incrementally. The server-managed SSE loop (streamServerAgentLoop) therefore
    // arrives buffered: one burst at completion, with the duplicate-message artefacts
    // that come from re-flushing accumulated deltas. So when proxied we drive the
    // agent loop CLIENT-side instead: one buffered round-trip per turn, with each
    // assistant message and tool result rendered as it happens (genuine step-by-step
    // progress). Server-managed credentials still apply — the client loop posts to
    // /api/ai/chat and the proxy injects the key, so no client API key is needed.
    const isProxied = (window as unknown as { __UCC_PROXIED__?: boolean }).__UCC_PROXIED__ === true;
    const useServerStream = isServerManaged && !isProxied;

    if (!isServerManaged && !apiKey) {
      setError('Please set your OpenRouter API key in Settings first.');
      setShowSettings(true);
      return;
    }

    const userMessage: ChatMessage = {
      role: 'user',
      content: text,
      timestamp: new Date(),
    };

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    if (!overrideText) setInputValue('');
    setIsLoading(true);
    setError(null);
    setOfferContinue(false);
    setUsage(null);
    runAbortRef.current = new AbortController();

    // Initial system message
    const systemContent = buildSystemMessage();

    // Use a truncated version of messages to avoid context overflow if needed
    // Simple heuristic: keep system + last 10 messages
    const contextMessages = newMessages.length > 20 ? newMessages.slice(-20) : newMessages;

    // Summarize older messages if we dropped any
    let systemPrefix = '';
    if (newMessages.length > 20) {
      systemPrefix =
        'User: [Prior conversation summarized] We are continuing a previous discussion.\n';
    }

    const apiMessages = [
      { role: 'system', content: systemPrefix + systemContent },
      ...contextMessages.map((m) => {
        const msg: {
          role: string;
          content: string;
          tool_calls?: unknown[];
          tool_call_id?: string;
          name?: string;
        } = { role: m.role, content: m.content };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.name) msg.name = m.name;
        return msg;
      }),
    ];

    try {
      if (useServerStream) {
        const systemContent = buildSystemMessage();
        const contextMessages = newMessages.length > 20 ? newMessages.slice(-20) : newMessages;
        let systemPrefix = '';
        if (newMessages.length > 20) {
          systemPrefix =
            'User: [Prior conversation summarized] We are continuing a previous discussion.\n';
        }
        const apiMessages = contextMessages.map((m) => {
          const msg: {
            role: string;
            content: string;
            tool_calls?: unknown[];
            tool_call_id?: string;
            name?: string;
          } = {
            role: m.role,
            content: m.content,
          };
          if (m.tool_calls) msg.tool_calls = m.tool_calls;
          if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
          if (m.name) msg.name = m.name;
          return msg;
        });

        await streamServerAgentLoop({
          sessionId: getSessionId(),
          model: activeModel,
          system: systemPrefix + systemContent,
          messages: apiMessages,
          files: vfs.getAllFiles(),
          maxIterations,
          toolPolicy: toolPolicyOverrides,
        });
        return;
      }

      let keepGoing = true;
      let iterations = 0;
      // No-progress breaker (mirrors the server agentRunner): stop if the same
      // tool+args keeps returning an error / identical result N times in a row.
      const NO_PROGRESS_LIMIT = aiConfig?.agent?.noProgressLimit ?? 3;
      let lastToolSig: string | null = null;
      let toolRepeatCount = 0;
      let stoppedNoProgress = false;

      while (keepGoing && iterations < maxIterations) {
        if (runAbortRef.current?.signal.aborted) {
          throw Object.assign(new Error('Stopped by user.'), { name: 'AbortError' });
        }
        iterations++;

        const requestBody = JSON.stringify({
          model: activeModel,
          messages: apiMessages,
          stream: true,
          max_tokens: 4096,
          tools: toolRegistry.toOpenAIFormat(),
        });

        const url = isServerManaged
          ? '/api/ai/chat'
          : 'https://openrouter.ai/api/v1/chat/completions';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };

        if (!isServerManaged) {
          headers['Authorization'] = `Bearer ${apiKey}`;
          headers['HTTP-Referer'] = 'https://splunk.engineer';
          headers['X-Title'] = 'UCCBuilder';
        }

        const response = await fetchWithRetry(url, {
          method: 'POST',
          headers,
          body: requestBody,
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        let fullContent = '';
        const toolCalls: Record<
          number,
          { id: string; function: { name: string; arguments: string } }
        > = {};

        // Temporary assistant message for streaming
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: '',
            timestamp: new Date(),
          },
        ]);

        for await (const event of parseStream(response)) {
          if (event.type === 'content') {
            fullContent += event.content;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last.role === 'assistant' && !last.tool_calls) {
                return [...prev.slice(0, -1), { ...last, content: fullContent }];
              }
              return prev;
            });
          } else if (event.type === 'tool_call') {
            const tc = event.toolCall;
            const idx = event.index;

            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id || '',
                function: { name: '', arguments: '' },
              };
            }

            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          } else if (event.type === 'error') {
            throw new Error(event.error);
          }
        }

        const finalToolCalls = Object.values(toolCalls).map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));

        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: fullContent,
          timestamp: new Date(),
          tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
        };

        apiMessages.push(assistantMsg);

        if (finalToolCalls.length > 0) {
          keepGoing = true;
          // Feed the no-progress breaker; returns true when the loop should stop.
          const recordToolOutcome = (
            toolName: string,
            args: Record<string, unknown>,
            content: string,
            errored: boolean
          ): boolean => {
            const isErr =
              errored || /\b(error|failed|invalid|denied|security error)\b/i.test(content);
            const tail = isErr ? 'ERR' : `R:${content.length}:${content.slice(0, 200)}`;
            const sig = `${toolName}|${JSON.stringify(args)}|${tail}`;
            if (sig === lastToolSig) toolRepeatCount += 1;
            else {
              lastToolSig = sig;
              toolRepeatCount = 1;
            }
            return toolRepeatCount >= NO_PROGRESS_LIMIT;
          };

          for (const toolCall of finalToolCalls) {
            const toolName = toolCall.function.name;
            const tool = toolRegistry.get(toolName);

            if (!tool) {
              apiMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: toolName,
                content: `Error: Tool ${toolName} not found`,
              });
              continue;
            }

            let toolArgs: Record<string, unknown> = {};
            try {
              toolArgs = JSON.parse(toolCall.function.arguments || '{}');
            } catch (parseErr) {
              apiMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: toolName,
                content: `Error parsing arguments: ${String(parseErr)}`,
              });
              continue;
            }

            // Consult the approval policy for EVERY tool. `auto` runs silently (or
            // raises the diff card for write_file); `ask` prompts on first use then
            // is remembered for the session; `deny` is refused. requestApproval
            // encapsulates that decision and the session-approved memory.
            {
              const approved = await requestApproval(toolName, toolArgs);
              if (!approved) {
                const denyMsg =
                  resolveClientPolicy(toolName) === 'deny'
                    ? `Tool "${toolName}" is denied by policy and was not run. Proceed without it.`
                    : `User declined "${toolName}". Proceed without it.`;
                apiMessages.push({
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  name: toolName,
                  content: denyMsg,
                });
                setMessages((prev) => [
                  ...prev,
                  {
                    role: 'system',
                    content: denyMsg,
                    timestamp: new Date(),
                  } as ChatMessage,
                ]);
                continue;
              }
            }

            try {
              const result = await tool.execute(toolArgs, vfs, { onBuildTrigger });
              if (toolName === 'todo_write' && Array.isArray(toolArgs.todos)) {
                applyTodoPayload(toolArgs.todos);
              }
              if (toolName === 'record_decision') {
                const d = toolArgs as Record<string, unknown>;
                if (d.id && d.question && d.decision) {
                  setDecisions((prev) => {
                    const next = prev.filter((x) => x.id !== String(d.id));
                    next.push({
                      id: String(d.id),
                      question: String(d.question),
                      decision: String(d.decision),
                      rationale: String(d.rationale || ''),
                    });
                    return next;
                  });
                }
              }
              apiMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: toolName,
                content: result,
              });

              // Update UI with tool result
              setMessages((prev) => [
                ...prev,
                {
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  name: toolName,
                  content: result,
                  toolPath: typeof toolArgs.path === 'string' ? toolArgs.path : undefined,
                  timestamp: new Date(),
                },
              ]);
              if (recordToolOutcome(toolName, toolArgs, result, false)) {
                stoppedNoProgress = true;
              }
            } catch (err: unknown) {
              const errorMsg = `Error executing tool: ${err instanceof Error ? err.message : String(err)}`;
              apiMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: toolName,
                content: errorMsg,
              });
              setMessages((prev) => [
                ...prev,
                {
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  name: toolName,
                  content: errorMsg,
                  timestamp: new Date(),
                },
              ]);
              if (recordToolOutcome(toolName, toolArgs, errorMsg, true)) {
                stoppedNoProgress = true;
              }
            }
          }
          if (stoppedNoProgress) {
            keepGoing = false;
            setMessages((prev) => [
              ...prev,
              {
                role: 'system',
                content: `⚠️ Stopped: repeated ${lastToolSig?.split('|')[0] ?? 'tool'} with no progress (${toolRepeatCount}x identical result). Try a different approach.`,
                timestamp: new Date(),
              } as ChatMessage,
            ]);
          }
        } else {
          keepGoing = false;
        }
      }

      if (iterations >= maxIterations && keepGoing && !stoppedNoProgress) {
        setOfferContinue(true);
        setMessages((prev) => [
          ...prev,
          {
            role: 'system',
            content:
              '⚠️ Reached maximum tool iterations. Click "Continue" below to let the agent keep going, or ask specifically.',
            timestamp: new Date(),
          } as ChatMessage,
        ]);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError' || runAbortRef.current?.signal.aborted) {
        setMessages((prev) => [
          ...prev,
          { role: 'system', content: '⏹ Stopped by user.', timestamp: new Date() } as ChatMessage,
        ]);
      } else {
        setError((err as Error).message);
      }
    } finally {
      runAbortRef.current = null;
      setIsLoading(false);
    }
  };

  /** Stop button: abort the in-flight run (server cancels on disconnect). */
  const stopRun = () => {
    runAbortRef.current?.abort();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <>
      <SidePanel
        open={open}
        dockPosition="right"
        // Only close on Esc or the explicit × button — clickAway also fires when
        // focus returns after a browser tab switch, which silently shut the panel.
        onRequestClose={(data: { reason?: string }) => {
          if (data?.reason !== 'clickAway') onRequestClose();
        }}
        innerStyle={{ width: panelWidth, height: '100vh' }}
      >
        <PanelInner $width={panelWidth}>
          <ResizeHandle $isResizing={isResizing} onMouseDown={startResize} title="Drag to resize" />
          <PanelHeader>
            <Heading level={3} style={{ margin: 0 }}>
              AI Assistant
            </Heading>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                appearance={showSettings ? 'primary' : 'default'}
                onClick={() => setShowSettings(!showSettings)}
                label={showSettings ? 'Close Settings' : 'Settings'}
              />
              <Button appearance="default" onClick={onRequestClose} label="×" />
            </div>
          </PanelHeader>

          {showSettings ? (
            <>
              <SettingsSection style={{ padding: '12px 20px' }}>
                {isLoading && (
                  <Message type="warning" style={{ marginBottom: 12 }}>
                    The agent is still running in the background. Close Settings to watch its
                    progress or stop it. Model changes apply to the NEXT message, not the current
                    run.
                  </Message>
                )}
                {aiConfig?.serverManaged ? (
                  <Message type="success" style={{ marginBottom: 12 }}>
                    AI is server-managed — no API key needed.
                  </Message>
                ) : (
                  <>
                    <ControlGroup
                      label="OpenRouter API Key"
                      labelPosition="top"
                      help="Your API key is stored only in browser session memory and never sent to any server other than OpenRouter."
                    >
                      <Text
                        value={apiKey}
                        onChange={(_e: unknown, { value }: { value: string }) => saveApiKey(value)}
                        placeholder="sk-or-v1-..."
                        type="password"
                      />
                    </ControlGroup>
                    {apiKey && (
                      <Message type="success" style={{ marginTop: 8 }}>
                        API key configured
                      </Message>
                    )}
                  </>
                )}

                <ControlGroup
                  label="Model"
                  labelPosition="top"
                  help={
                    remoteModels.length
                      ? `Live list of ${remoteModels.length} tool-calling models from OpenRouter — or use a custom model ID.`
                      : 'Select a model or use a custom model ID from OpenRouter.'
                  }
                  style={{ marginTop: 16 }}
                >
                  <Select
                    value={selectedModel}
                    onChange={(_e: unknown, { value }: { value: string | number | boolean }) =>
                      saveModel(String(value))
                    }
                    disabled={useCustomModel}
                    filter
                  >
                    {(remoteModels.length
                      ? // Keep the saved selection choosable even if it left the live list.
                        remoteModels.some((m) => m.id === selectedModel)
                        ? remoteModels
                        : [
                            {
                              id: selectedModel,
                              label: selectedModel,
                              provider: selectedModel.split('/')[0] ?? '',
                              contextLength: 0,
                            },
                            ...remoteModels,
                          ]
                      : AVAILABLE_MODELS.map((m) => ({
                          id: m.id,
                          label: m.label,
                          provider: m.provider,
                          contextLength: 0,
                        }))
                    ).map((m) => (
                      <Select.Option
                        key={m.id}
                        label={
                          m.contextLength
                            ? `${m.label} — ${Math.round(m.contextLength / 1000)}k ctx`
                            : `${m.label} (${m.provider})`
                        }
                        value={m.id}
                      />
                    ))}
                  </Select>
                </ControlGroup>

                <div style={{ marginTop: 12 }}>
                  <Switch
                    selected={useCustomModel}
                    onClick={() => setUseCustomModel(!useCustomModel)}
                    appearance="toggle"
                  >
                    Use custom model ID
                  </Switch>
                </div>

                {useCustomModel && (
                  <ControlGroup
                    label="Custom Model ID"
                    labelPosition="top"
                    help="Enter any OpenRouter model ID (e.g., mistralai/mixtral-8x22b)"
                    style={{ marginTop: 8 }}
                  >
                    <Text
                      value={customModelId}
                      onChange={(_e: unknown, { value }: { value: string }) =>
                        setCustomModelId(value)
                      }
                      placeholder="provider/model-name"
                    />
                  </ControlGroup>
                )}

                <Message type="info" style={{ marginTop: 12 }}>
                  Active: {activeModel}
                </Message>
                {aiConfig?.capabilities && (
                  <Message type="info" style={{ marginTop: 8 }}>
                    Docker tools:{' '}
                    {aiConfig.capabilities.dockerToolsEnabled ? 'enabled' : 'disabled'} | Browser
                    check: {aiConfig.capabilities.browserCheckEnabled ? 'enabled' : 'disabled'}
                  </Message>
                )}
                {aiConfig?.capabilities && (
                  <Message type="info" style={{ marginTop: 8 }}>
                    Local docs index:{' '}
                    {aiConfig.capabilities.localDocsIndexEnabled ? 'enabled' : 'disabled'} |
                    Live-Splunk MCP grounding:{' '}
                    {aiConfig.capabilities.mcpGroundingEnabled
                      ? 'enabled'
                      : 'disabled (standalone)'}
                  </Message>
                )}

                <div
                  style={{
                    marginTop: 16,
                    paddingTop: 16,
                    borderTop: '1px solid rgba(255,255,255,0.1)',
                  }}
                >
                  <Switch
                    selected={autoAccept}
                    onClick={() => saveAutoAccept(!autoAccept)}
                    appearance="toggle"
                  >
                    Auto-accept tool actions
                  </Switch>
                  <p style={{ fontSize: '0.85em', color: '#9b9ea3', marginTop: 4 }}>
                    {autoAccept
                      ? 'Tools will execute without confirmation.'
                      : 'You will be prompted to approve file changes.'}
                  </p>
                </div>

                <ControlGroup
                  label="Max agent iterations"
                  labelPosition="top"
                  help={`How many planner/executor turns the agent may take before stopping (${MAX_ITER_MIN}–${MAX_ITER_MAX}). Lower values cap OpenRouter spend; the no-progress breaker also stops repeated failing actions early.`}
                  style={{ marginTop: 16 }}
                >
                  <Text
                    type="number"
                    value={String(maxIterations)}
                    onChange={(_e: unknown, { value }: { value: string }) => {
                      const n = Number(value);
                      if (Number.isFinite(n)) saveMaxIterations(n);
                    }}
                    inputMode="numeric"
                  />
                </ControlGroup>
                <p style={{ fontSize: '0.85em', color: '#9b9ea3', marginTop: 4 }}>
                  Default {aiConfig?.agent?.maxIterations ?? 12}
                  {aiConfig?.agent?.noProgressLimit
                    ? ` · no-progress breaker at ${aiConfig.agent.noProgressLimit} repeats`
                    : ''}
                  .
                </p>

                <div
                  data-testid="tool-policy-settings"
                  style={{
                    marginTop: 16,
                    paddingTop: 16,
                    borderTop: '1px solid rgba(255,255,255,0.1)',
                  }}
                >
                  <Heading level={5} style={{ margin: '0 0 6px 0' }}>
                    Tool approval policy
                  </Heading>
                  <p style={{ fontSize: '0.85em', color: '#9b9ea3', margin: '0 0 10px 0' }}>
                    External-access tools require approval on first use (remembered for the
                    session). Toggle a tool to "Always ask" or "Auto (no prompt)". Saved locally and
                    applied per request.
                  </p>
                  {(() => {
                    // The external/ask tools, merged from the server (live-Splunk MCP +
                    // any deploy/external-fetch tools) and the browser-only client tools.
                    const serverAsk = aiConfig?.toolPolicy?.askTools ?? [];
                    const askTools = Array.from(
                      new Set([...serverAsk, ...CLIENT_ASK_TOOLS])
                    ).sort();
                    return askTools.map((tool) => {
                      const effective = resolveClientPolicy(tool);
                      const alwaysAsk = effective !== 'auto';
                      return (
                        <div
                          key={tool}
                          data-testid={`tool-policy-row-${tool}`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '4px 0',
                          }}
                        >
                          <code style={{ fontSize: '0.8em' }}>{tool}</code>
                          <Switch
                            selected={alwaysAsk}
                            onClick={() => saveToolPolicyOverride(tool, alwaysAsk ? 'auto' : 'ask')}
                            appearance="toggle"
                            data-testid={`tool-policy-toggle-${tool}`}
                          >
                            {alwaysAsk ? 'Always ask' : 'Auto'}
                          </Switch>
                        </div>
                      );
                    });
                  })()}
                </div>
              </SettingsSection>
              <PanelFooter>
                <Button
                  appearance="primary"
                  onClick={() => setShowSettings(false)}
                  label="Done — back to chat"
                />
              </PanelFooter>
            </>
          ) : (
            <>
              <PanelBody>
                {(planText || todos.length > 0 || decisions.length > 0) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {planText && (
                      <Message type="info">
                        <strong>Plan</strong>
                        <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{planText}</div>
                      </Message>
                    )}
                    {todos.length > 0 && (
                      <Message type="warning">
                        <strong>Todo Tracker</strong>
                        <div style={{ marginTop: 6 }}>
                          {todos.map((t) => (
                            <div key={t.id}>
                              [{t.status}] {t.content}
                            </div>
                          ))}
                        </div>
                      </Message>
                    )}
                    {decisions.length > 0 && (
                      <Message type="success">
                        <strong>Decision Log</strong>
                        <div style={{ marginTop: 6 }}>
                          {decisions.slice(-5).map((d) => (
                            <div key={d.id}>
                              {d.question} {'->'} {d.decision}
                            </div>
                          ))}
                        </div>
                      </Message>
                    )}
                  </div>
                )}
                {messages.length === 0 ? (
                  <EmptyState>
                    <div style={{ fontSize: '2rem' }}>&#x1F916;</div>
                    <Heading level={4}>Splunk App Assistant</Heading>
                    <p>
                      Ask about UCC configuration, Python scripts, .conf file settings, or anything
                      related to building Splunk apps.
                    </p>
                    {context?.currentFile && (
                      <Message type="info" style={{ textAlign: 'left', width: '100%' }}>
                        Context: {context.currentFile}
                      </Message>
                    )}
                  </EmptyState>
                ) : (
                  messages
                    .filter((msg) => msg.content.trim() !== '') // Filter out empty messages
                    .map((msg, i) => (
                      <MessageBubble
                        key={i}
                        $role={msg.role}
                        // File viewers need real width — stretch their bubble.
                        style={msg.name === 'read_file' ? { width: '90%' } : undefined}
                      >
                        {msg.role === 'assistant' ? (
                          <MarkdownContent>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                          </MarkdownContent>
                        ) : msg.role === 'tool' ? (
                          <ToolMessage name={msg.name} content={msg.content} path={msg.toolPath} />
                        ) : (
                          msg.content
                        )}
                      </MessageBubble>
                    ))
                )}

                {isLoading && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <WaitSpinner />
                    <span style={{ color: '#9b9ea3', fontSize: '0.875rem' }}>Thinking...</span>
                  </div>
                )}

                {error && <Message type="error">{error}</Message>}

                <div ref={messagesEndRef} />
              </PanelBody>

              <PanelFooter>
                <TextArea
                  value={inputValue}
                  onChange={(_e: unknown, { value }: { value: string }) => setInputValue(value)}
                  onKeyDown={handleKeyDown}
                  rowsMin={3}
                  rowsMax={8}
                  disabled={isLoading}
                  style={{ width: '100%' }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  {isLoading ? (
                    <Button appearance="destructive" onClick={stopRun} label="⏹ Stop" />
                  ) : (
                    <Button
                      appearance="primary"
                      onClick={() => sendMessage()}
                      disabled={!inputValue.trim()}
                      label="Send"
                    />
                  )}
                  {!isLoading && offerContinue && (
                    <Button
                      appearance="primary"
                      onClick={() =>
                        sendMessage(
                          'Continue from where you stopped: resume the remaining todos and finish the task. Do not repeat work that is already completed.'
                        )
                      }
                      label={`▶ Continue (+${maxIterations} iterations)`}
                    />
                  )}
                  {messages.length > 0 && (
                    <Button appearance="default" onClick={clearChat} label="Clear Chat" />
                  )}
                </div>
                {usage && (usage.promptTokens > 0 || usage.completionTokens > 0) && (
                  <UsageBar>{renderUsage(usage, activeModel, remoteModels)}</UsageBar>
                )}
              </PanelFooter>
            </>
          )}
        </PanelInner>
      </SidePanel>

      {/* Tool Approval Modal */}
      <Modal
        open={!!pendingApproval}
        onRequestClose={() => handleApprovalResponse('deny')}
        style={{ width: '90vw', maxWidth: '1200px' }}
        returnFocus={modalReturnRef}
      >
        <Modal.Header title={`Review AI Changes: ${pendingApproval?.toolName}`} />
        <Modal.Body>
          {pendingApproval?.reason && (
            <Message type="warning" data-testid="approval-reason" style={{ marginBottom: 12 }}>
              {pendingApproval.reason}
            </Message>
          )}
          {pendingApproval?.toolName === 'write_file' ? (
            <div style={{ height: '60vh', display: 'flex', flexDirection: 'column' }}>
              <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between' }}>
                <span>
                  <strong>File:</strong> {pendingApproval.args.path as string}
                </span>
                <span>
                  {pendingApproval.existingContent
                    ? 'Modifying existing file'
                    : 'Creating new file'}
                </span>
              </div>
              <div style={{ flex: 1, border: '1px solid #ccc' }}>
                <DiffEditor
                  original={pendingApproval.existingContent || ''}
                  modified={(pendingApproval.args.content as string) || ''}
                  language="python"
                  theme="vs-dark"
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    renderSideBySide: true,
                  }}
                />
              </div>
            </div>
          ) : (
            <div>
              <p>
                The AI wants to execute: <strong>{pendingApproval?.toolName}</strong>
              </p>
              <div
                style={{
                  background: '#f5f5f5',
                  padding: 10,
                  borderRadius: 4,
                  maxHeight: '300px',
                  overflow: 'auto',
                }}
              >
                <pre style={{ margin: 0 }}>{JSON.stringify(pendingApproval?.args, null, 2)}</pre>
              </div>
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button
            appearance="secondary"
            onClick={() => handleApprovalResponse('deny')}
            label="Deny"
            data-testid="approval-deny"
            style={{ marginRight: 10 }}
          />
          <Button
            appearance="default"
            onClick={() => handleApprovalResponse('approve_session')}
            label="Approve for session"
            data-testid="approval-approve-session"
            style={{ marginRight: 10 }}
          />
          <Button
            appearance="primary"
            onClick={() => handleApprovalResponse('approve')}
            label={pendingApproval?.toolName === 'write_file' ? 'Approve & Apply' : 'Approve'}
            data-testid="approval-approve"
          />
        </Modal.Footer>
      </Modal>
    </>
  );
}
