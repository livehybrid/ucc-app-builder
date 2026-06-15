// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { lintRouter } from './lint';

// setupTests.ts stubs global.fetch; use node http directly for real requests.
function httpPost(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: chunks }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('POST /api/lint/python', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', lintRouter);
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('accepts valid python', async () => {
    const res = await httpPost(`${base}/api/lint/python`, {
      code: 'import json\n\ndef f(x):\n    return json.dumps(x)\n',
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it('reports a SyntaxError with position', async () => {
    const res = await httpPost(`${base}/api/lint/python`, { code: 'def f(:\n    pass\n' });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.ok).toBe(false);
    expect(parsed.line).toBe(1);
    expect(typeof parsed.col).toBe('number');
    expect(parsed.msg).toBeTruthy();
  });

  it('rejects a missing code field', async () => {
    const res = await httpPost(`${base}/api/lint/python`, { nope: true });
    expect(res.status).toBe(400);
  });
});
