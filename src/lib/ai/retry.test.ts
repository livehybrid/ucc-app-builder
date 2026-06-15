import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchWithRetry } from './retry';

const fetchMock = vi.fn();
global.fetch = fetchMock as unknown as typeof fetch;

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return successful response immediately', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });

    const response = await fetchWithRetry('/api/test');
    expect(response.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('should retry on 429 errors', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await fetchWithRetry('/api/test', undefined, {
      maxRetries: 1,
      initialDelay: 10,
    });
    expect(response.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('should retry on 5xx errors', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await fetchWithRetry('/api/test', undefined, {
      maxRetries: 1,
      initialDelay: 10,
    });
    expect(response.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('should not retry on 400 errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });

    await expect(fetchWithRetry('/api/test', undefined, { maxRetries: 1 })).rejects.toThrow(
      'HTTP error! status: 400'
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('should fail after max retries', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await expect(
      fetchWithRetry('/api/test', undefined, { maxRetries: 2, initialDelay: 1 })
    ).rejects.toThrow('Max retries reached');
    expect(global.fetch).toHaveBeenCalledTimes(3); // Initial + 2 retries
  });
});
