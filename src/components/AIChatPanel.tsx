import { useState, useRef, useCallback, useEffect } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { toolRegistry } from '../lib/ai/tools';
import { parseStream } from '../lib/ai/streamParser';
import { fetchWithRetry } from '../lib/ai/retry';
import { buildSystemMessage } from '../lib/ai/prompts';
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
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

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
  /** When set, auto-populates the input and sends the message, then clears via onExternalPromptConsumed */
  externalPrompt?: string | null;
  onExternalPromptConsumed?: () => void;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
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
  width: ${props => props.$width}px;
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
  background: ${props => props.$isResizing ? 'rgba(101, 166, 55, 0.5)' : 'transparent'};
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
    background: ${props => props.$isResizing ? '#65A637' : 'rgba(255,255,255,0.2)'};
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

const SettingsSection = styled.div`
  padding: 12px 0;
  border-bottom: 1px solid ${variables.borderColor};
  margin-bottom: 12px;
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
  border: 1px solid ${(props) =>
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

const MarkdownContent = styled.div`
  /* Reset markdown styles for chat */
  p { margin: 0 0 0.5em 0; }
  p:last-child { margin-bottom: 0; }
  
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
  ul, ol {
    margin: 8px 0;
    padding-left: 24px;
  }
  
  li { margin: 4px 0; }
  
  /* Headers */
  h1, h2, h3, h4 {
    margin: 12px 0 8px 0;
    font-weight: 600;
  }
  h1 { font-size: 1.2em; }
  h2 { font-size: 1.1em; }
  h3, h4 { font-size: 1em; }
  
  /* Links */
  a {
    color: #65A637;
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

const SuggestedActionsBar = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 0 4px;
`;

const SuggestionButton = styled.button`
  background: rgba(101, 166, 55, 0.12);
  border: 1px solid rgba(101, 166, 55, 0.4);
  border-radius: 16px;
  color: #65A637;
  cursor: pointer;
  font-size: 0.8rem;
  padding: 6px 14px;
  transition: background 0.15s, border-color 0.15s;

  &:hover {
    background: rgba(101, 166, 55, 0.25);
    border-color: rgba(101, 166, 55, 0.7);
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

/**
 * Markdown code-block renderer with Prism syntax highlighting.
 * Inline code (single-backtick) keeps the existing `code` styling above; only
 * fenced blocks (```lang ... ```) get the highlighter so JSON/Python/diff
 * snippets in AI responses render with colors and proper line breaks instead
 * of one continuous string.
 */
const CodeBlock = ({
  inline,
  className,
  children,
  ...rest
}: {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
}) => {
  const match = /language-(\w+)/.exec(className || '');
  const text = String(children ?? '').replace(/\n$/, '');
  if (!inline && match) {
    return (
      <SyntaxHighlighter
        language={match[1]}
        style={oneDark}
        PreTag="div"
        customStyle={{ margin: '8px 0', borderRadius: 6, fontSize: '0.8em' }}
      >
        {text}
      </SyntaxHighlighter>
    );
  }
  return <code className={className} {...rest}>{children}</code>;
};

/**
 * Format raw tool output for display:
 *  - If it parses as JSON, pretty-print
 *  - Otherwise return as-is (line breaks preserved by <pre>)
 * Keeps tool-result bubbles readable instead of one giant unbroken string.
 */
function formatToolOutput(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // not valid JSON — fall through
    }
  }
  return raw;
}

const API_KEY_STORAGE = 'splunk-app-builder-openrouter-key';
const MODEL_STORAGE = 'splunk-app-builder-ai-model';
const AUTOACCEPT_STORAGE = 'splunk-app-builder-ai-autoaccept';
const CHAT_HISTORY_STORAGE = 'splunk-app-builder-chat-history';
const PANEL_WIDTH_STORAGE = 'splunk-app-builder-panel-width';
const AGENT_SESSION_KEY = 'ucc-agent-session-id';

// Default model for new sessions. Sonnet 4.6 is the strongest balance of
// quality + cost for coding agents with tool use, per the user's preference.
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';

// Curated list of OpenRouter models that pair well with this agent loop:
// every entry below supports tool/function calling and is competitive on
// SWE-bench-style coding tasks. Listed roughly best → cheapest within each
// provider. Users can still pick "Custom model ID" for anything not here.
const AVAILABLE_MODELS = [
  // Anthropic — current Claude 4 family
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6 (Recommended)', provider: 'Anthropic' },
  { id: 'anthropic/claude-opus-4.7', label: 'Claude Opus 4.7 (best quality)', provider: 'Anthropic' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5 (fast & cheap)', provider: 'Anthropic' },
  // Moonshot — strongest open-source on SWE-bench Verified
  { id: 'moonshotai/kimi-k2', label: 'Kimi K2.6', provider: 'Moonshot' },
  // OpenAI
  { id: 'openai/gpt-5', label: 'GPT-5', provider: 'OpenAI' },
  { id: 'openai/gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
  // Google
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Google' },
  { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash', provider: 'Google' },
  // xAI
  { id: 'x-ai/grok-3', label: 'Grok 3', provider: 'xAI' },
  // DeepSeek — cost-effective open weights
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3', provider: 'DeepSeek' },
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
  };
}

// Pending tool approval state type
interface PendingApproval {
  toolName: string;
  args: Record<string, unknown>;
  resolve: (approved: boolean) => void;
  existingContent?: string;
}

export function AIChatPanel({ open, onRequestClose, context, vfs, onVfsChange, onBuildTrigger, externalPrompt, onExternalPromptConsumed }: AIChatPanelProps) {
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem(API_KEY_STORAGE) || '');
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL);
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null);

  // Detect server-managed AI mode on mount
  useEffect(() => {
    fetch('/api/ai/config')
      .then(res => res.json())
      .then((config: AIConfig) => {
        setAiConfig(config);
        if (config.serverManaged && !localStorage.getItem(MODEL_STORAGE)) {
          setSelectedModel(config.defaultModel);
        }
      })
      .catch(() => {
        // Server not available, fall back to client mode
        setAiConfig({ serverManaged: false, defaultModel: DEFAULT_MODEL });
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
        return parsed.map((m: { role: string; content: string; timestamp: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }) => ({ ...m, timestamp: new Date(m.timestamp) }));
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
        const appId = config.meta?.id || config.meta?.name?.toLowerCase().replace(/[^a-z0-9]/g, '_');
        
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
  const [planText, setPlanText] = useState('');
  const [todos, setTodos] = useState<AgentTodo[]>([]);
  const [decisions, setDecisions] = useState<AgentDecision[]>([]);
  const [suggestedActions, setSuggestedActions] = useState<Array<{ label: string; prompt: string }>>([]);
  
  // Auto-accept toggle (persisted to localStorage)
  const [autoAccept, setAutoAccept] = useState(() => localStorage.getItem(AUTOACCEPT_STORAGE) === 'true');
  
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
  const clearChat = () => {
    setMessages([]);
    setError(null);
    setPlanText('');
    setTodos([]);
    setDecisions([]);
    localStorage.removeItem(CHAT_HISTORY_STORAGE);
  };

  // Request approval for a tool action - returns a promise that resolves when user approves/rejects  
  const requestApproval = (toolName: string, args: Record<string, unknown>): Promise<boolean> => {
    // If auto-accept is enabled, always approve
    if (autoAccept) {
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

    // Show modal and wait for user response
    return new Promise((resolve) => {
      setPendingApproval({
        toolName,
        args,
        resolve,
        existingContent,
      });
    });
  };

  const handleApprovalResponse = (approved: boolean) => {
    if (pendingApproval) {
      pendingApproval.resolve(approved);
      setPendingApproval(null);
    }
  };

  const buildSystemMessageForSession = (): string =>
    buildSystemMessage(context, vfs, aiConfig);

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
        status: String((item as Record<string, unknown>).status || 'pending') as AgentTodo['status'],
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

  const streamServerAgentLoop = async (
    payload: {
      sessionId: string;
      model: string;
      system: string;
      messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>;
      files: Array<{ path: string; content: string }>;
    },
  ) => {
    const response = await fetch('/api/ai/agent/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
        if (toolName === 'todo_write' && parsedArgs && (parsedArgs as Record<string, unknown>).todos) {
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

      if (name === 'iteration') {
        // Reset streaming buffers at the start of each agent iteration so the
        // next assistant_delta creates a NEW message bubble. Without this,
        // iteration N+1's content gets appended to iteration N's bubble and
        // every subsequent bubble re-renders the full concatenated history.
        assistantContent = '';
        hasAssistantMessage = false;
        return;
      }

      if (name === 'assistant_delta' && parsed.content) {
        assistantContent += String(parsed.content);
        setMessages((prev) => {
          if (!hasAssistantMessage) {
            hasAssistantMessage = true;
            return [...prev, { role: 'assistant', content: assistantContent, timestamp: new Date() }];
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
        // Suppress UI-only tools from appearing as chat bubbles
        if (String(parsed.name || '') === 'suggest_actions') return;
        setMessages((prev) => [
          ...prev,
          {
            role: 'tool',
            content: String(parsed.content || ''),
            name: String(parsed.name || ''),
            tool_call_id: String(parsed.id || ''),
            timestamp: new Date(),
          },
        ]);
        return;
      }

      if (name === 'warning' && parsed.message) {
        setMessages((prev) => [
          ...prev,
          { role: 'system', content: String(parsed.message), timestamp: new Date() },
        ]);
        return;
      }

      if (name === 'files' && Array.isArray(parsed.files)) {
        applyServerFiles(parsed.files as Array<{ path: string; content: string }>);
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

      if (name === 'suggest_actions' && Array.isArray(parsed.actions)) {
        setSuggestedActions(parsed.actions as Array<{ label: string; prompt: string }>);
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

  const sendMessage = async (overrideContent?: string) => {
    const content = (overrideContent ?? inputValue).trim();
    if (!content || isLoading) return;

    const isServerManaged = aiConfig?.serverManaged ?? false;

    if (!isServerManaged && !apiKey) {
      setError('Please set your OpenRouter API key in Settings first.');
      setShowSettings(true);
      return;
    }

    const userMessage: ChatMessage = {
      role: 'user',
      content,
      timestamp: new Date(),
    };

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    if (!overrideContent) setInputValue('');
    setIsLoading(true);
    setError(null);
    setSuggestedActions([]);

    // Initial system message
    const systemContent = buildSystemMessageForSession();
    
    // Use a truncated version of messages to avoid context overflow if needed
    // Simple heuristic: keep system + last 10 messages
    const contextMessages = newMessages.length > 20 
      ? newMessages.slice(-20) 
      : newMessages;
      
    // Summarize older messages if we dropped any
    let systemPrefix = "";
    if (newMessages.length > 20) {
       systemPrefix = "User: [Prior conversation summarized] We are continuing a previous discussion.\n";
    }

    const apiMessages = [
      { role: 'system', content: systemPrefix + systemContent },
      ...contextMessages.map((m) => {
        const msg: { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string } = { role: m.role, content: m.content };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.name) msg.name = m.name;
        return msg;
      }),
    ];

    try {
      if (isServerManaged) {
        const systemContent = buildSystemMessageForSession();
        const contextMessages = newMessages.length > 20 ? newMessages.slice(-20) : newMessages;
        let systemPrefix = '';
        if (newMessages.length > 20) {
          systemPrefix = 'User: [Prior conversation summarized] We are continuing a previous discussion.\n';
        }
        const apiMessages = contextMessages.map((m) => {
          const msg: { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string } = {
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
        });
        return;
      }

      let keepGoing = true;
      let iterations = 0;
      
      while (keepGoing && iterations < 15) {
        iterations++;
        
        const requestBody = JSON.stringify({
          model: activeModel,
          messages: apiMessages,
          stream: true, 
          max_tokens: 4096,
          tools: toolRegistry.toOpenAIFormat()
        });

        const url = isServerManaged ? '/api/ai/chat' : 'https://openrouter.ai/api/v1/chat/completions';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        
        if (!isServerManaged) {
           headers['Authorization'] = `Bearer ${apiKey}`;
           headers['HTTP-Referer'] = 'https://splunk.engineer';
           headers['X-Title'] = 'UCCBuilder';
        }

        const response = await fetchWithRetry(url, {
             method: 'POST',
             headers,
             body: requestBody
        });

        if (!response.ok) {
           throw new Error(`API error: ${response.status}`);
        }

        let fullContent = '';
        const toolCalls: Record<number, { id: string; function: { name: string; arguments: string } }> = {};
        
        // Temporary assistant message for streaming
        setMessages(prev => [...prev, {
            role: 'assistant',
            content: '',
            timestamp: new Date()
        }]);

        for await (const event of parseStream(response)) {
            if (event.type === 'content') {
                fullContent += event.content;
                setMessages(prev => {
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
                        function: { name: '', arguments: '' } 
                    };
                }
                
                if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            } else if (event.type === 'error') {
                throw new Error(event.error);
            }
        }

        const finalToolCalls = Object.values(toolCalls).map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
                name: tc.function.name,
                arguments: tc.function.arguments
            }
        }));

        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: fullContent,
          timestamp: new Date(),
          tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined
        };
        
        apiMessages.push(assistantMsg);
        
        if (finalToolCalls.length > 0) {
          keepGoing = true;
          
          for (const toolCall of finalToolCalls) {
            const toolName = toolCall.function.name;
            const tool = toolRegistry.get(toolName);
            
            if (!tool) {
                 apiMessages.push({
                     role: 'tool',
                     tool_call_id: toolCall.id,
                     name: toolName,
                     content: `Error: Tool ${toolName} not found`
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
                     content: `Error parsing arguments: ${String(parseErr)}`
                 });
                 continue;
            }

            if (['write_file', 'build_app', 'run_ucc_gen', 'run_appinspect', 'install_to_splunk_docker', 'browser_check'].includes(toolName)) {
                const approved = await requestApproval(toolName, toolArgs);
                if (!approved) {
                    apiMessages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        name: toolName,
                        content: 'User denied permission to execute this tool.'
                    });
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
                if (toolName === 'suggest_actions' && Array.isArray(toolArgs.actions)) {
                  setSuggestedActions(toolArgs.actions as Array<{ label: string; prompt: string }>);
                }
                 apiMessages.push({
                     role: 'tool',
                     tool_call_id: toolCall.id,
                     name: toolName,
                     content: result
                 });

                 // Suppress UI-only tools from appearing as chat bubbles
                 if (toolName !== 'suggest_actions') {
                   setMessages(prev => [...prev, {
                      role: 'tool',
                      tool_call_id: toolCall.id,
                      name: toolName,
                      content: result,
                      timestamp: new Date()
                   }]);
                 }
            } catch (err: unknown) {
                 const errorMsg = `Error executing tool: ${err instanceof Error ? err.message : String(err)}`;
                 apiMessages.push({
                     role: 'tool',
                     tool_call_id: toolCall.id,
                     name: toolName,
                     content: errorMsg
                 });
                 setMessages(prev => [...prev, {
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    name: toolName,
                    content: errorMsg,
                    timestamp: new Date()
                 }]);
            }
          }
        } else {
            keepGoing = false;
        }
      }
      
      if (iterations >= 15) {
         setMessages(prev => [...prev, {
             role: 'system',
             content: '⚠️ Reached maximum tool iterations. Please continue or ask specifically.',
             timestamp: new Date()
         } as ChatMessage]);
      }

    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  // When a "Fix it" prompt arrives from outside (e.g. AppInspect panel), open chat and send it.
  useEffect(() => {
    if (!externalPrompt) return;
    onExternalPromptConsumed?.();
    sendMessage(externalPrompt);
    // sendMessage is stable within a render; externalPrompt is the only real dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalPrompt]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <>
    <SidePanel open={open} dockPosition="right" onRequestClose={onRequestClose} innerStyle={{ width: panelWidth, height: '100vh' }}>
      <PanelInner $width={panelWidth}>
        <ResizeHandle $isResizing={isResizing} onMouseDown={startResize} title="Drag to resize" />
        <PanelHeader>
          <Heading level={3} style={{ margin: 0 }}>AI Assistant</Heading>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              appearance={showSettings ? 'primary' : 'default'}
              onClick={() => setShowSettings(!showSettings)}
              label="Settings"
            />
            <Button appearance="default" onClick={onRequestClose} label="×" />
          </div>
        </PanelHeader>

        {showSettings && (
          <SettingsSection style={{ padding: '12px 20px' }}>
            {aiConfig?.serverManaged ? (
              <Message type="success" style={{ marginBottom: 12 }}>
                AI is server-managed — no API key needed.
              </Message>
            ) : (
              <>
                <ControlGroup label="OpenRouter API Key" labelPosition="top" help="Your API key is stored only in browser session memory and never sent to any server other than OpenRouter.">
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

            <ControlGroup label="Model" labelPosition="top" help="Select a model or use a custom model ID from OpenRouter." style={{ marginTop: 16 }}>
              <Select
                value={selectedModel}
                onChange={(_e: unknown, { value }: { value: string | number | boolean }) => saveModel(String(value))}
                disabled={useCustomModel}
              >
                {AVAILABLE_MODELS.map(m => (
                  <Select.Option key={m.id} label={`${m.label} (${m.provider})`} value={m.id} />
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
              <ControlGroup label="Custom Model ID" labelPosition="top" help="Enter any OpenRouter model ID (e.g., mistralai/mixtral-8x22b)" style={{ marginTop: 8 }}>
                <Text
                  value={customModelId}
                  onChange={(_e: unknown, { value }: { value: string }) => setCustomModelId(value)}
                  placeholder="provider/model-name"
                />
              </ControlGroup>
            )}

            <Message type="info" style={{ marginTop: 12 }}>
              Active: {activeModel}
            </Message>
            {aiConfig?.capabilities && (
              <Message type="info" style={{ marginTop: 8 }}>
                Docker tools: {aiConfig.capabilities.dockerToolsEnabled ? 'enabled' : 'disabled'} | Browser check: {aiConfig.capabilities.browserCheckEnabled ? 'enabled' : 'disabled'}
              </Message>
            )}
            {aiConfig?.capabilities && (
              <Message type="info" style={{ marginTop: 8 }}>
                Local docs index: {aiConfig.capabilities.localDocsIndexEnabled ? 'enabled' : 'disabled'}
              </Message>
            )}

            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              <Switch
                selected={autoAccept}
                onClick={() => saveAutoAccept(!autoAccept)}
                appearance="toggle"
              >
                Auto-accept tool actions
              </Switch>
              <p style={{ fontSize: '0.85em', color: '#9b9ea3', marginTop: 4 }}>
                {autoAccept ? 'Tools will execute without confirmation.' : 'You will be prompted to approve file changes.'}
              </p>
            </div>
          </SettingsSection>
        )}

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
                Ask about UCC configuration, Python scripts, .conf file settings, or anything related to building Splunk apps.
              </p>
              {context?.currentFile && (
                <Message type="info" style={{ textAlign: 'left', width: '100%' }}>
                  Context: {context.currentFile}
                </Message>
              )}
            </EmptyState>
          ) : (
            messages
              .filter(msg => msg.content.trim() !== '') // Filter out empty messages
              .map((msg, i) => (
              <MessageBubble key={i} $role={msg.role}>
                {msg.role === 'assistant' ? (
                  <MarkdownContent>
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{ code: CodeBlock }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  </MarkdownContent>
                ) : msg.role === 'tool' ? (
                  // Tool output is often raw JSON or multi-line text — render in
                  // a <pre> so newlines survive, and pretty-print JSON.
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {formatToolOutput(msg.content)}
                  </pre>
                ) : (
                  msg.content
                )}
              </MessageBubble>
            ))
          )}

          {suggestedActions.length > 0 && !isLoading && (
            <SuggestedActionsBar>
              {suggestedActions.map((action, i) => (
                <SuggestionButton
                  key={i}
                  onClick={() => sendMessage(action.prompt)}
                  title={action.prompt}
                >
                  {action.label}
                </SuggestionButton>
              ))}
            </SuggestedActionsBar>
          )}

          {isLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <WaitSpinner />
              <span style={{ color: '#9b9ea3', fontSize: '0.875rem' }}>Thinking...</span>
            </div>
          )}

          {error && (
            <Message type="error">{error}</Message>
          )}

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
            <Button
              appearance="primary"
              onClick={() => sendMessage()}
              disabled={!inputValue.trim() || isLoading}
              label="Send"
            />
            {messages.length > 0 && (
              <Button
                appearance="default"
                onClick={clearChat}
                label="Clear Chat"
              />
            )}
          </div>
        </PanelFooter>
      </PanelInner>
    </SidePanel>

    {/* Tool Approval Modal */}
    <Modal 
      open={!!pendingApproval} 
      onRequestClose={() => handleApprovalResponse(false)}
      style={{ width: '90vw', maxWidth: '1200px' }}
      returnFocus={modalReturnRef}
    >
      <Modal.Header title={`Review AI Changes: ${pendingApproval?.toolName}`} />
      <Modal.Body>
        {pendingApproval?.toolName === 'write_file' ? (
          <div style={{ height: '60vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between' }}>
               <span><strong>File:</strong> {pendingApproval.args.path as string}</span>
               <span>{pendingApproval.existingContent ? 'Modifying existing file' : 'Creating new file'}</span>
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
            <p>The AI wants to execute: <strong>{pendingApproval?.toolName}</strong></p>
            <div style={{ background: '#f5f5f5', padding: 10, borderRadius: 4, maxHeight: '300px', overflow: 'auto' }}>
              <pre style={{ margin: 0 }}>{JSON.stringify(pendingApproval?.args, null, 2)}</pre>
            </div>
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button 
          appearance="secondary" 
          onClick={() => handleApprovalResponse(false)} 
          label="Reject" 
          style={{ marginRight: 10 }}
        />
        <Button 
          appearance="primary" 
          onClick={() => handleApprovalResponse(true)} 
          label="Approve & Apply" 
        />
      </Modal.Footer>
    </Modal>
    </>
  );
}
