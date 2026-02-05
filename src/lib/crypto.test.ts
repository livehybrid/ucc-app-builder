import { describe, it, expect } from 'vitest';
import { sha256, calculateChecksums } from './crypto';

describe('sha256', () => {
  it('should calculate consistent hashes', async () => {
    const hash1 = await sha256('hello world');
    const hash2 = await sha256('hello world');
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different content', async () => {
    const hash1 = await sha256('hello');
    const hash2 = await sha256('world');
    expect(hash1).not.toBe(hash2);
  });

  it('should produce 64-character hex string', async () => {
    const hash = await sha256('test');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('calculateChecksums', () => {
  it('should calculate checksums for multiple files', async () => {
    const files = [
      { path: '/a.txt', content: 'content a' },
      { path: '/b.txt', content: 'content b' },
    ];

    const checksums = await calculateChecksums(files);

    expect(checksums.size).toBe(2);
    expect(checksums.has('/a.txt')).toBe(true);
    expect(checksums.has('/b.txt')).toBe(true);
    expect(checksums.get('/a.txt')).not.toBe(checksums.get('/b.txt'));
  });
});
