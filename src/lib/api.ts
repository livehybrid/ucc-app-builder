/**
 * API client for communicating with the ucc-gen backend
 */

// Runtime override (set by the native Splunk app page to its locale-correct REST
// proxy, which forwards to the build engine) takes precedence over the build-time env.
const API_BASE =
  (typeof window !== 'undefined' && (window as unknown as { __UCC_API_BASE__?: string }).__UCC_API_BASE__) ||
  import.meta.env.VITE_API_URL ||
  'http://localhost:3001/api';

export interface BuildStatus {
  id: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  progress: number;
  logs: string[];
  error?: string;
  outputPath?: string;
  appId?: string;
  startedAt: string;
  completedAt?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface UCCVersionInfo {
  version: string | null;
  available: boolean;
  error?: string;
}

/**
 * Check if the backend is available
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get the installed ucc-gen version
 */
export async function getUCCVersion(): Promise<UCCVersionInfo> {
  try {
    const response = await fetch(`${API_BASE}/ucc-version`);
    return await response.json();
  } catch {
    return { version: null, available: false, error: 'Backend not available' };
  }
}

/**
 * Validate a globalConfig.json without building
 */
export async function validateConfig(globalConfig: object): Promise<ValidationResult> {
  const response = await fetch(`${API_BASE}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ globalConfig }),
  });

  if (!response.ok) {
    throw new Error('Validation request failed');
  }

  return await response.json();
}

/**
 * Start a new build
 */
export async function startBuild(
  files: Array<{ path: string; content: string }>,
  appId: string,
  metadata?: Record<string, string>
): Promise<{ buildId: string; status: string }> {
  const response = await fetch(`${API_BASE}/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, appId, metadata }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Build request failed');
  }

  return await response.json();
}

/**
 * Get build status and logs
 */
export async function getBuildStatus(buildId: string): Promise<BuildStatus> {
  const response = await fetch(`${API_BASE}/build/${buildId}`);

  if (!response.ok) {
    throw new Error('Failed to get build status');
  }

  return await response.json();
}

/**
 * Poll for build completion
 */
export async function waitForBuild(
  buildId: string,
  onProgress?: (status: BuildStatus) => void,
  pollInterval = 1000
): Promise<BuildStatus> {
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const status = await getBuildStatus(buildId);
        onProgress?.(status);

        if (status.status === 'success' || status.status === 'failed') {
          resolve(status);
        } else {
          setTimeout(poll, pollInterval);
        }
      } catch (error) {
        reject(error);
      }
    };

    poll();
  });
}

/**
 * Download the built app package
 */
export async function downloadBuild(buildId: string, appId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/build/${buildId}/download`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Download failed');
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${appId}.tgz`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Agentic AppInspect loop (the keystone): generate -> appinspect -> fix -> repeat.
// Streamed over SSE from POST /api/agent/build-loop.
// ---------------------------------------------------------------------------

export type LoopEventKind =
  | 'start'
  | 'build'
  | 'build_error'
  | 'package'
  | 'inspect'
  | 'fix'
  | 'fix_skipped'
  | 'iteration'
  | 'clean'
  | 'exhausted'
  | 'done';

export interface LoopEvent {
  kind: LoopEventKind;
  iteration: number;
  ts: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LoopFile {
  path: string;
  content: string;
}

export interface LoopResult {
  ok: boolean;
  clean: boolean;
  iterations: number;
  appId: string;
  tarball?: string;
  finalSummary?: string;
  finalReport?: {
    summary?: Record<string, number>;
    source?: string;
  };
  files: LoopFile[];
  events: LoopEvent[];
}

export interface RunLoopOptions {
  sessionId: string;
  appId: string;
  files: LoopFile[];
  version?: string;
  maxIterations?: number;
  includeWarnings?: boolean;
  useLlm?: boolean;
  llmOnly?: boolean;
  onEvent: (e: LoopEvent) => void;
  signal?: AbortSignal;
}

/**
 * Run the agentic build loop and stream its events. Resolves with the final
 * LoopResult. Uses fetch + a manual SSE parser (EventSource can't POST a body).
 */
export async function runBuildLoop(opts: RunLoopOptions): Promise<LoopResult> {
  const { onEvent, signal, ...body } = opts;
  const response = await fetch(`${API_BASE}/agent/build-loop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`build-loop failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: LoopResult | undefined;
  let errorMsg: string | undefined;

  const handleBlock = (block: string) => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    if (event === 'loop') onEvent(payload as LoopEvent);
    else if (event === 'result') result = payload as LoopResult;
    else if (event === 'error') errorMsg = (payload as { error?: string }).error ?? 'loop error';
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleBlock(block);
    }
  }
  if (buffer.trim()) handleBlock(buffer);

  if (errorMsg) throw new Error(errorMsg);
  if (!result) throw new Error('build-loop ended without a result event');
  return result;
}
