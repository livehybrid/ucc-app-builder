
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { pushFiles } from './github';
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
    fetchMock.mockResolvedValueOnce({ // getRef
      ok: true,
      json: async () => ({ ref: 'refs/heads/main', object: { sha: 'parent-sha' } }),
    });
    fetchMock.mockResolvedValueOnce({ // getCommit
      ok: true,
      json: async () => ({ tree: { sha: 'base-tree-sha' } }),
    });
    fetchMock.mockResolvedValueOnce({ // createTree
      ok: true,
      json: async () => ({ sha: 'new-tree-sha' }),
    });
    fetchMock.mockResolvedValueOnce({ // createCommit
      ok: true,
      json: async () => ({ sha: 'new-commit-sha' }),
    });
    fetchMock.mockResolvedValueOnce({ // updateRef
      ok: true,
      json: async () => ({}),
    });

    await pushFiles(token, repo, vfs, 'commit message');

    // Check the createTree call (3rd call)
    // calls: 0=getRef, 1=getCommit, 2=createTree
    const calls = fetchMock.mock.calls as Array<[string, { method: string; body: string }]>;
    const createTreeCall = calls.find((call: [string, { method: string; body: string }]) => 
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
    expect(paths.some((p: string) => p.includes('my_app') && p !== 'globalConfig.json')).toBe(false); // globalConfig content has my_app, not path
    expect(paths.some((p: string) => p.startsWith('my_app/'))).toBe(false);
  });

  it('should use fallback appId (repoName) if globalConfig is missing', async () => {
     // Setup VFS without globalConfig, but paths use repoName "repo-name"
     const vfs = new VirtualFileSystem();
     vfs.writeFile('/repo-name/package/app.conf', '# content');

    // Mock responses
    fetchMock.mockResolvedValue({ // Default catch-all
      ok: true,
      json: async () => ({ sha: 'sha', object: { sha: 'sha' }, tree: { sha: 'sha' } }),
    });
    // Need specifically the getRef to return object.sha
    fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/git/refs/')) return { ok: true, json: async () => ({ ref: 'refs/heads/main', object: { sha: 'p' } }) };
        if (url.includes('/git/commits/')) return { ok: true, json: async () => ({ tree: { sha: 't' } }) };
        return { ok: true, json: async () => ({ sha: 's' }) };
    });

    await pushFiles(token, repo, vfs, 'msg');

    const calls = fetchMock.mock.calls as Array<[string, { method: string; body: string }]>;
    const createTreeCall = calls.find((call: [string, { method: string; body: string }]) => 
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
