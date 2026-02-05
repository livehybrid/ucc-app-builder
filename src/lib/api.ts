/**
 * API client for communicating with the ucc-gen backend
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

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

export interface ValidationResult {
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
