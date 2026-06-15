// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { generateRouter } from './generate';

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

describe('generate routes (standalone MCP-tool artifact generation)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', generateRouter);
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  describe('POST /api/generate/dashboard', () => {
    it('emits a Dashboard Studio v2 view from title + panels', async () => {
      const res = await httpPost(`${base}/api/generate/dashboard`, {
        title: '4xx Overview',
        description: 'web errors',
        panels: [{ title: 'Errors', spl: 'index=web status>=400 | timechart count', viz: 'line' }],
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.fileName).toBe('4xx_overview.xml');
      expect(body.path).toBe('package/default/data/ui/views/4xx_overview.xml');
      expect(body.content).toMatch(/<dashboard version="2"/);
      const json = body.content.slice(
        body.content.indexOf('<![CDATA[') + 9,
        body.content.indexOf(']]>')
      );
      expect(JSON.parse(json).visualizations.viz_0.type).toBe('splunk.line');
    });

    it('accepts panels passed as a JSON STRING (the Splunk MCP arg-coercion path)', async () => {
      const res = await httpPost(`${base}/api/generate/dashboard`, {
        title: 'Stringy',
        panels: JSON.stringify([{ title: 'p', spl: 'index=x', viz: 'single' }]),
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      const json = body.content.slice(
        body.content.indexOf('<![CDATA[') + 9,
        body.content.indexOf(']]>')
      );
      expect(JSON.parse(json).visualizations.viz_0.type).toBe('splunk.singlevalue');
    });

    it('400s when panels[] is empty or missing', async () => {
      const res = await httpPost(`${base}/api/generate/dashboard`, { title: 'No panels' });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).ok).toBe(false);
    });
  });

  describe('POST /api/generate/savedsearch', () => {
    it('builds a plain report stanza', async () => {
      const res = await httpPost(`${base}/api/generate/savedsearch`, {
        name: 'Daily 4xx',
        search: 'index=web status>=400 | stats count',
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.path).toBe('package/default/savedsearches.conf');
      expect(body.stanza).toMatch(/^\[Daily 4xx\]/);
      expect(body.stanza).toMatch(/search = index=web status>=400 \| stats count/);
    });

    it('accepts alert passed as a JSON STRING and emits alerting keys', async () => {
      const res = await httpPost(`${base}/api/generate/savedsearch`, {
        name: 'Alerting',
        search: 'index=web status>=500 | stats count',
        cronSchedule: '*/5 * * * *',
        alert: JSON.stringify({ condition: 'greater than', threshold: 0 }),
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.stanza).toMatch(/enableSched = 1/);
      expect(body.stanza).toMatch(/cron_schedule = \*\/5 \* \* \* \*/);
      expect(body.stanza).toMatch(/alert_type = greater than/);
    });

    it('400s when name or search is missing', async () => {
      const res = await httpPost(`${base}/api/generate/savedsearch`, { name: 'NoSearch' });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).ok).toBe(false);
    });
  });

  describe('POST /api/generate/tests', () => {
    it('emits a pytest-splunk-addon scaffold from addon + sourcetypes', async () => {
      const res = await httpPost(`${base}/api/generate/tests`, {
        addonName: 'ta_weather',
        sourcetypes: [{ sourcetype: 'weatherapi:obs', sampleEvents: ['{"temp":21}'] }],
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      const paths = body.files.map((f: { path: string }) => f.path);
      expect(paths).toContain('tests/data/pytest-splunk-addon-data.conf');
      expect(paths).toContain('tests/data/samples/weatherapi_obs.sample');
      expect(paths).toContain('tests/test_ta_weather.py');
      const sample = body.files.find(
        (f: { path: string }) => f.path === 'tests/data/samples/weatherapi_obs.sample'
      );
      expect(sample.content).toBe('{"temp":21}\n');
    });

    it('accepts sourcetypes passed as a JSON STRING (Splunk MCP arg-coercion path)', async () => {
      const res = await httpPost(`${base}/api/generate/tests`, {
        addonName: 'ta_x',
        sourcetypes: JSON.stringify([{ sourcetype: 'x:y' }]),
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);
    });

    it('400s when addonName or sourcetypes is missing', async () => {
      const res = await httpPost(`${base}/api/generate/tests`, { addonName: 'ta_x' });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).ok).toBe(false);
    });
  });
});
