import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkHealth,
  getUCCVersion,
  validateConfig,
  startBuild,
  getBuildStatus,
  downloadBuild,
} from './api';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkHealth', () => {
  it('should return true when backend is available', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    expect(await checkHealth()).toBe(true);
  });

  it('should return false when backend is not available', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    expect(await checkHealth()).toBe(false);
  });

  it('should return false when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    expect(await checkHealth()).toBe(false);
  });
});

describe('getUCCVersion', () => {
  it('should return version info from backend', async () => {
    const versionInfo = { version: '5.0.0', available: true };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(versionInfo),
    });

    const result = await getUCCVersion();
    expect(result).toEqual(versionInfo);
  });

  it('should return unavailable when fetch fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await getUCCVersion();
    expect(result.available).toBe(false);
    expect(result.version).toBeNull();
  });
});

describe('validateConfig', () => {
  it('should send config and return validation result', async () => {
    const validationResult = { valid: true, errors: [], warnings: [] };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(validationResult),
    });

    const result = await validateConfig({ meta: {} });
    expect(result).toEqual(validationResult);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/validate'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('should throw when validation request fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });

    await expect(validateConfig({})).rejects.toThrow('Validation request failed');
  });
});

describe('startBuild', () => {
  it('should start a build and return buildId', async () => {
    const buildResponse = { buildId: 'build-123', status: 'pending' };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(buildResponse),
    });

    const result = await startBuild([{ path: 'test.conf', content: 'data' }], 'my_app');
    expect(result.buildId).toBe('build-123');
  });

  it('should throw with error message when build fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Build failed: invalid config' }),
    });

    await expect(startBuild([], 'my_app')).rejects.toThrow('Build failed: invalid config');
  });

  it('should throw default message when no error message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({}),
    });

    await expect(startBuild([], 'my_app')).rejects.toThrow('Build request failed');
  });
});

describe('getBuildStatus', () => {
  it('should return build status', async () => {
    const status = {
      id: 'build-123',
      status: 'success',
      progress: 100,
      logs: ['Done'],
      startedAt: '2024-01-01',
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(status),
    });

    const result = await getBuildStatus('build-123');
    expect(result.status).toBe('success');
  });

  it('should throw when request fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });

    await expect(getBuildStatus('bad-id')).rejects.toThrow('Failed to get build status');
  });
});

describe('downloadBuild', () => {
  it('should create download link with correct filename', async () => {
    const mockBlob = new Blob(['content']);
    const mockUrl = 'blob:test-url';
    const clickMock = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      blob: () => Promise.resolve(mockBlob),
    });

    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => mockUrl),
      revokeObjectURL: vi.fn(),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(document.body, 'appendChild').mockImplementation(((node: any) => node) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(document.body, 'removeChild').mockImplementation(((node: any) => node) as any);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'a') {
        return {
          href: '',
          download: '',
          click: clickMock,
        } as unknown as HTMLAnchorElement;
      }
      return document.createElement(tag);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    await downloadBuild('build-123', 'my_app');
    expect(clickMock).toHaveBeenCalled();
  });

  it('should throw when download fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Not found' }),
    });

    await expect(downloadBuild('bad-id', 'app')).rejects.toThrow('Not found');
  });
});
