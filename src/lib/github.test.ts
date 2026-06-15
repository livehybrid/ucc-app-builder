import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { pushFiles, initiateDeviceFlow, deviceFlowErrorMessage } from './github';
import { VirtualFileSystem } from './vfs';
import type { GitHubRepo } from '../types/github';

describe('pushFiles', () => {
  const token = 'fake-token';
  const repo: GitHubRepo = {
    id: 1,
    name: 'repo-name',
    full_name: 'owner/repo-name',
    private: false,
    html_url: 'http://github.com/owner/repo-name',
    description: '',
    default_branch: 'main',
  };

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should transform paths correctly (strip appId, ensure package/)', async () => {
    // Setup VFS with "my_app" ID
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/my_app/globalConfig.json', JSON.stringify({ meta: { name: 'my_app' } }));
    vfs.writeFile('/my_app/package/default/app.conf', '# content');
    vfs.writeFile('/my_app/package/bin/script.py', '# script');

    // Mock responses for the git flow
    fetchMock.mockResolvedValueOnce({
      // getRef
      ok: true,
      json: async () => ({ ref: 'refs/heads/main', object: { sha: 'parent-sha' } }),
    });
    fetchMock.mockResolvedValueOnce({
      // getCommit
      ok: true,
      json: async () => ({ tree: { sha: 'base-tree-sha' } }),
    });
    fetchMock.mockResolvedValueOnce({
      // createTree
      ok: true,
      json: async () => ({ sha: 'new-tree-sha' }),
    });
    fetchMock.mockResolvedValueOnce({
      // createCommit
      ok: true,
      json: async () => ({ sha: 'new-commit-sha' }),
    });
    fetchMock.mockResolvedValueOnce({
      // updateRef
      ok: true,
      json: async () => ({}),
    });

    await pushFiles(token, repo, vfs, 'commit message');

    // Check the createTree call (3rd call)
    // calls: 0=getRef, 1=getCommit, 2=createTree
    const calls = fetchMock.mock.calls as Array<[string, { method: string; body: string }]>;
    const createTreeCall = calls.find(
      (call: [string, { method: string; body: string }]) =>
        call[0].includes('/git/trees') && call[1].method === 'POST'
    );

    expect(createTreeCall).toBeDefined();
    if (!createTreeCall) {
      throw new Error('Expected createTree call to exist');
    }
    const body = JSON.parse(createTreeCall[1].body);
    const tree = body.tree;

    // Verify paths
    const paths = tree.map((t: { path: string }) => t.path).sort();

    // globalConfig.json should be at root
    expect(paths).toContain('globalConfig.json');

    // other files should be in package/
    expect(paths).toContain('package/default/app.conf');
    expect(paths).toContain('package/bin/script.py');

    // Should NOT contain my_app prefix
    expect(paths.some((p: string) => p.includes('my_app') && p !== 'globalConfig.json')).toBe(
      false
    ); // globalConfig content has my_app, not path
    expect(paths.some((p: string) => p.startsWith('my_app/'))).toBe(false);
  });

  it('should use fallback appId (repoName) if globalConfig is missing', async () => {
    // Setup VFS without globalConfig, but paths use repoName "repo-name"
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/repo-name/package/app.conf', '# content');

    // Mock responses
    fetchMock.mockResolvedValue({
      // Default catch-all
      ok: true,
      json: async () => ({ sha: 'sha', object: { sha: 'sha' }, tree: { sha: 'sha' } }),
    });
    // Need specifically the getRef to return object.sha
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/git/refs/'))
        return { ok: true, json: async () => ({ ref: 'refs/heads/main', object: { sha: 'p' } }) };
      if (url.includes('/git/commits/'))
        return { ok: true, json: async () => ({ tree: { sha: 't' } }) };
      return { ok: true, json: async () => ({ sha: 's' }) };
    });

    await pushFiles(token, repo, vfs, 'msg');

    const calls = fetchMock.mock.calls as Array<[string, { method: string; body: string }]>;
    const createTreeCall = calls.find(
      (call: [string, { method: string; body: string }]) =>
        call[0].includes('/git/trees') && call[1].method === 'POST'
    );
    expect(createTreeCall).toBeDefined();
    if (!createTreeCall) {
      throw new Error('Expected createTree call to exist');
    }
    const body = JSON.parse(createTreeCall[1].body);
    const paths = body.tree.map((t: { path: string }) => t.path);

    // Should strip "repo-name" since it matches repo.name passed to pushFiles
    expect(paths).toContain('package/app.conf');
    expect(paths.some((p: string) => p.startsWith('repo-name/'))).toBe(false);
  });
});

describe('initiateDeviceFlow', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts to the backend proxy and returns the device code on success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          device_code: 'dc',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 899,
          interval: 5,
        }),
    });

    const res = await initiateDeviceFlow('Iv1.realclientid');

    // Goes through the backend proxy, not GitHub directly (CORS).
    expect(fetchMock.mock.calls[0][0]).toBe('/api/github/device/code');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.client_id).toBe('Iv1.realclientid');
    expect(res.user_code).toBe('ABCD-1234');
  });

  it('throws an actionable error on GitHub 404 (unknown Client ID)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Not Found' }),
    });

    await expect(initiateDeviceFlow('bogus')).rejects.toThrow(/did not recognise this Client ID/i);
  });

  it('explains device_flow_disabled even when GitHub returns 200', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ error: 'device_flow_disabled' }),
    });

    await expect(initiateDeviceFlow('Iv1.app')).rejects.toThrow(/Enable Device Flow/i);
  });

  it('requires a client id before calling the network', async () => {
    await expect(initiateDeviceFlow('   ')).rejects.toThrow(/Client ID/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('deviceFlowErrorMessage', () => {
  it('maps 404 / Not Found to a Client ID hint', () => {
    expect(deviceFlowErrorMessage(404, '{"error":"Not Found"}')).toMatch(/Client ID/i);
  });
  it('maps device_flow_disabled to the enable-device-flow hint', () => {
    expect(deviceFlowErrorMessage(200, '{"error":"device_flow_disabled"}')).toMatch(
      /Enable Device Flow/i
    );
  });
  it('falls back to the status code for unknown errors', () => {
    expect(deviceFlowErrorMessage(500, 'oops')).toMatch(/500/);
  });
});
