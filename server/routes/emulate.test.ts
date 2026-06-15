// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { emulateRouter } from './emulate';

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

// A self-contained helper that emits one event WITHOUT any HTTP — keeps the test
// hermetic (no network) while still exercising the real harness end-to-end:
// exec the source, resolve collect_events, call it with the stub helper + EventWriter.
const NO_HTTP_HELPER = `
import import_declare_test  # UCC bootstrap — shimmed by the harness

def collect_events(helper, ew):
    helper.log_info("collecting")
    name = helper.get_arg("name") or "world"
    ew.write_event(helper.new_event(data={"hello": name}, sourcetype="emu:test"))
`;

describe('POST /api/emulate/input', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', emulateRouter);
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('runs collect_events and returns the events it would index', async () => {
    const res = await httpPost(`${base}/api/emulate/input`, {
      helperCode: NO_HTTP_HELPER,
      args: { name: 'splunk' },
      index: 'main',
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.count).toBe(1);
    const ev = body.events[0];
    expect(JSON.parse(ev.data)).toEqual({ hello: 'splunk' });
    expect(ev.sourcetype).toBe('emu:test');
    expect(ev.index).toBe('main');
    expect(body.logs.join('\n')).toMatch(/\[INFO\] collecting/);
  });

  it('400s when helperCode is missing', async () => {
    const res = await httpPost(`${base}/api/emulate/input`, { args: {} });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).ok).toBe(false);
  });

  it('surfaces a structured error when the helper defines no collect_events', async () => {
    const res = await httpPost(`${base}/api/emulate/input`, {
      helperCode: 'X = 1\n',
      args: {},
    });
    // The harness prints {ok:false, error:...}; the route relays it as 200 JSON.
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(String(body.error)).toMatch(/collect_events|stream_events/);
  });
});
