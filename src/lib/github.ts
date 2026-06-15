import { GitHubAuth, GitHubUser, GitHubRepo, DeviceFlowResponse } from '../types/github';
import type { VirtualFileSystem } from './vfs';
import { convertToSourcePath, getAppIdFromVFS } from './exporter';

// Client ID is now provided by the user in the UI

const API_BASE = 'https://api.github.com';

class GitHubError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new GitHubError(errorData.message || response.statusText, response.status);
  }

  return response.json();
}

// --- OAuth Device Flow ---

/**
 * Turn a GitHub device-flow failure into an actionable message. GitHub returns
 * `404 {"error":"Not Found"}` when the Client ID isn't a recognised OAuth App,
 * and `{"error":"device_flow_disabled"}` when the app exists but Device Flow is
 * off — both of which otherwise surface to the user as a bare "404".
 */
export function deviceFlowErrorMessage(status: number, body: string): string {
  let parsed: { error?: string; error_description?: string } = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    /* non-JSON body */
  }
  if (parsed.error === 'device_flow_disabled') {
    return 'Device Flow is not enabled on this OAuth App. In GitHub → Settings → Developer settings → OAuth Apps → your app, tick “Enable Device Flow”, then try again.';
  }
  if (status === 404 || parsed.error === 'Not Found') {
    return 'GitHub did not recognise this Client ID. Check that you created an OAuth App, ticked “Enable Device Flow” on it, and pasted the exact Client ID (not the client secret).';
  }
  return `Failed to initiate device flow: ${status}${parsed.error ? ` (${parsed.error})` : ''}`;
}

export async function initiateDeviceFlow(clientId: string): Promise<DeviceFlowResponse> {
  if (!clientId || !clientId.trim()) {
    throw new Error('Enter your GitHub OAuth App Client ID first.');
  }
  // Backend proxy (server/index.ts) forwards to https://github.com/login/device/code
  // — GitHub's OAuth endpoints don't send CORS headers, so the browser can't call
  // them directly.
  const response = await fetch('/api/github/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId.trim(),
      scope: 'repo user',
    }),
  });

  const text = await response.text();
  // GitHub signals device_flow_disabled in the JSON body even on a 200, so check
  // the payload regardless of HTTP status.
  let data: DeviceFlowResponse & { error?: string } = {} as DeviceFlowResponse;
  try {
    data = JSON.parse(text);
  } catch {
    /* fall through to status-based error */
  }
  if (!response.ok || data.error || !data.device_code) {
    console.error('Device flow error:', response.status, text);
    throw new Error(deviceFlowErrorMessage(response.status, text));
  }
  return data;
}

export async function pollForToken(
  clientId: string,
  deviceCode: string,
  interval: number
): Promise<GitHubAuth> {
  const check = async (): Promise<GitHubAuth | null> => {
    // Backend proxy (server/index.ts) forwards to https://github.com/login/oauth/access_token
    const response = await fetch('/api/github/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = await response.json();

    if (data.error) {
      if (data.error === 'authorization_pending') return null;
      if (data.error === 'slow_down') throw new Error('Polling too frequently');
      if (data.error === 'expired_token') throw new Error('Device code expired');
      if (data.error === 'access_denied') throw new Error('User denied access');
      throw new Error(data.error_description || data.error);
    }

    return {
      accessToken: data.access_token,
      tokenType: data.token_type,
      scope: data.scope,
    };
  };

  return new Promise((resolve, reject) => {
    const start = Date.now();
    // Use minimum 5 second polling interval to avoid rate limiting
    const pollInterval = Math.max(5, interval + 1) * 1000;

    const poll = async () => {
      try {
        if (Date.now() - start > 15 * 60 * 1000) {
          // 15 min timeout
          reject(new Error('Timed out waiting for authentication'));
          return;
        }

        const token = await check();
        if (token) {
          resolve(token);
        } else {
          setTimeout(poll, pollInterval);
        }
      } catch (err) {
        reject(err);
      }
    };
    poll();
  });
}

// --- API Methods ---

export async function getUser(token: string): Promise<GitHubUser> {
  return request<GitHubUser>('/user', {}, token);
}

export async function listRepos(token: string): Promise<GitHubRepo[]> {
  // get all repos the user can push to
  return request<GitHubRepo[]>('/user/repos?sort=updated&per_page=100&type=all', {}, token);
}

export async function createRepo(
  token: string,
  name: string,
  isPrivate: boolean,
  description?: string
): Promise<GitHubRepo> {
  return request<GitHubRepo>(
    '/user/repos',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        private: isPrivate,
        description,
        auto_init: true, // Initialize with README to make standard push easier
      }),
    },
    token
  );
}

// --- Import/Clone Functions ---

interface GitTreeItem {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
  url: string;
}

interface GitTree {
  sha: string;
  url: string;
  tree: GitTreeItem[];
  truncated: boolean;
}

/**
 * Get the file tree for a repository
 */
async function getRepoTree(
  token: string,
  owner: string,
  repo: string,
  branch: string = 'main'
): Promise<GitTreeItem[]> {
  try {
    const tree = await request<GitTree>(
      `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
      {},
      token
    );
    // Filter to only return files (blobs), not directories
    return tree.tree.filter((item) => item.type === 'blob');
  } catch (error: unknown) {
    // Try 'master' branch if 'main' fails
    if (branch === 'main') {
      return getRepoTree(token, owner, repo, 'master');
    }
    throw error;
  }
}

/**
 * Get the content of a single file
 */
async function getFileContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string = 'main'
): Promise<string> {
  interface ContentResponse {
    content: string;
    encoding: string;
    type: string;
  }

  const response = await request<ContentResponse>(
    `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
    {},
    token
  );

  if (response.encoding === 'base64') {
    return atob(response.content.replace(/\n/g, ''));
  }
  return response.content;
}

/**
 * Clone a repository into the VFS
 */
export async function cloneRepo(
  token: string,
  repo: GitHubRepo,
  vfs: VirtualFileSystem,
  onProgress?: (current: number, total: number, file: string) => void
): Promise<{ fileCount: number; errors: string[] }> {
  const [owner, repoName] = repo.full_name.split('/');

  // Get all files in the repo
  const files = await getRepoTree(token, owner, repoName);
  const errors: string[] = [];

  // Clear VFS before importing
  vfs.clear();

  // Fetch and add each file
  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    if (onProgress) {
      onProgress(i + 1, files.length, file.path);
    }

    try {
      // Skip very large files (>1MB)
      if (file.size && file.size > 1024 * 1024) {
        errors.push(`Skipped large file: ${file.path} (${(file.size / 1024).toFixed(1)}KB)`);
        continue;
      }

      // Skip binary files by extension
      const ext = file.path.split('.').pop()?.toLowerCase();
      const binaryExts = [
        'png',
        'jpg',
        'jpeg',
        'gif',
        'ico',
        'woff',
        'woff2',
        'ttf',
        'eot',
        'zip',
        'tar',
        'gz',
        'exe',
        'dll',
        'so',
        'pyc',
      ];
      if (ext && binaryExts.includes(ext)) {
        errors.push(`Skipped binary file: ${file.path}`);
        continue;
      }

      const content = await getFileContent(token, owner, repoName, file.path);
      vfs.writeFile(file.path, content);
    } catch (err: unknown) {
      errors.push(
        `Failed to fetch ${file.path}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { fileCount: files.length - errors.length, errors };
}

// --- Git Data API (Commit & Push) ---

interface GitRef {
  ref: string;
  node_id: string;
  url: string;
  object: {
    type: string;
    sha: string;
    url: string;
  };
}

interface GitCommit {
  sha: string;
  tree: { sha: string };
  parents: { sha: string }[];
}

async function getRef(
  token: string,
  owner: string,
  repo: string,
  ref: string = 'heads/main'
): Promise<GitRef> {
  try {
    return await request<GitRef>(`/repos/${owner}/${repo}/git/ref/${ref}`, {}, token);
  } catch (e: unknown) {
    if (
      e instanceof Error &&
      'status' in e &&
      (e as { status: number }).status === 404 &&
      ref === 'heads/main'
    ) {
      // Try 'master' if main doesn't exist
      return await request<GitRef>(`/repos/${owner}/${repo}/git/ref/heads/master`, {}, token);
    }
    throw e;
  }
}

// Note: We no longer use createBlob individually - we use inline "content" in tree items
// This significantly reduces API calls when pushing multiple files

async function createTree(
  token: string,
  owner: string,
  repo: string,
  baseTreeSha: string | undefined,
  tree: Record<string, unknown>[]
): Promise<string> {
  const body: Record<string, unknown> = { tree };
  if (baseTreeSha) body.base_tree = baseTreeSha;

  const response = await request<{ sha: string }>(
    `/repos/${owner}/${repo}/git/trees`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    token
  );
  return response.sha;
}

async function createCommit(
  token: string,
  owner: string,
  repo: string,
  message: string,
  treeSha: string,
  parentSha?: string
): Promise<string> {
  const body: Record<string, unknown> = {
    message,
    tree: treeSha,
    parents: parentSha ? [parentSha] : [],
  };
  const response = await request<{ sha: string }>(
    `/repos/${owner}/${repo}/git/commits`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    token
  );
  return response.sha;
}

async function updateRef(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  sha: string
): Promise<void> {
  await request(
    `/repos/${owner}/${repo}/git/refs/${ref}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        sha,
        force: true, // Force push to overwrite if needed (careful!)
      }),
    },
    token
  );
}

export async function pushFiles(
  token: string,
  repo: GitHubRepo,
  vfs: VirtualFileSystem,
  message: string,
  filesToIgnore: string[] = [],
  /** Extra repo-relative files (path already relative to the repo root, NOT app-id
   *  prefixed) — e.g. a generated .github/workflows/build-validate.yml. */
  extraFiles: Array<{ path: string; content: string }> = []
): Promise<void> {
  const owner = repo.full_name.split('/')[0];
  const repoName = repo.name;

  // 1. Get current head commit
  let parentSha: string | undefined;
  let baseTreeSha: string | undefined;
  let refName = 'heads/main';

  try {
    const ref = await getRef(token, owner, repoName, 'heads/main').catch(() =>
      getRef(token, owner, repoName, 'heads/master')
    );
    refName = ref.ref.replace('refs/', '');
    parentSha = ref.object.sha;

    // Get commit to get tree
    const commit = await request<GitCommit>(
      `/repos/${owner}/${repoName}/git/commits/${parentSha}`,
      {},
      token
    );
    baseTreeSha = commit.tree.sha;
  } catch (e: unknown) {
    // If empty repo, no parents.
    // Usually auto_init creates one. If not, we start fresh.
    console.log('No ref found, starting fresh');
    refName = 'heads/main'; // Default to main
  }

  // 2. Build tree items with inline content (reduces API calls)
  // Instead of creating blobs individually, we use "content" in tree items
  // This lets GitHub create the blobs as part of the tree creation
  const treeItems: Record<string, unknown>[] = [];
  const files = vfs.toSnapshot().files;

  // Try to detect the real app ID from globalConfig to prevent nesting issues
  const appId = getAppIdFromVFS(vfs, repoName);

  for (const file of files) {
    if (filesToIgnore.includes(file.path)) continue;
    // Basic ignore logic
    if (file.path.includes('.git/')) continue;

    // Convert VFS path (e.g. /my_app/package/...) to source structure (package/...)
    // This handles removing the app ID prefix and ensuring proper package/ nesting
    const sourcePath = convertToSourcePath(file.path, appId);

    treeItems.push({
      path: sourcePath,
      mode: '100644', // normal file
      type: 'blob',
      content: file.content, // Use inline content instead of separate blob creation
    });
  }

  // Repo-relative extras (e.g. CI/CD workflow) — pushed at their given path verbatim.
  for (const extra of extraFiles) {
    if (!extra?.path) continue;
    treeItems.push({ path: extra.path, mode: '100644', type: 'blob', content: extra.content });
  }

  if (treeItems.length === 0) return;

  // 3. Create Tree
  const newTreeSha = await createTree(token, owner, repoName, baseTreeSha, treeItems);

  // 4. Create Commit
  const newCommitSha = await createCommit(token, owner, repoName, message, newTreeSha, parentSha);

  // 5. Update Ref
  const fullRef = `refs/${refName}`;
  if (!parentSha) {
    // Create ref if it doesn't exist (new branch/repo)
    // BUT, we need to know if we are creating or updating.
    // updateRef does PATCH. create ref does POST.
    // If we failed getRef, we likely need to create it?
    // Actually, if repo is empty, we can't create ref without commit.
    // We have commit now.
    // Try creating ref.
    await request(
      `/repos/${owner}/${repoName}/git/refs`,
      {
        method: 'POST',
        body: JSON.stringify({ ref: fullRef, sha: newCommitSha }),
      },
      token
    ).catch(async () => {
      // If failed, maybe it exists now? Try update
      await updateRef(token, owner, repoName, refName, newCommitSha);
    });
  } else {
    await updateRef(token, owner, repoName, refName, newCommitSha);
  }
}
