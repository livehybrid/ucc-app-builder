import { spawn, spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

/**
 * Splunk AppInspect wrapper.
 *
 * Prefers the `splunk-appinspect` CLI (pip-installable) when available. Falls
 * back to the public AppInspect REST API when `APPINSPECT_TOKEN` is set.
 *
 * Returns structured check results so the agent can iterate.
 */

export interface AppInspectCheck {
  check: string;
  result: 'success' | 'failure' | 'manual_check' | 'warning' | 'skipped' | 'error';
  message: string;
}

export interface AppInspectReport {
  summary: Record<string, number>;
  checks: AppInspectCheck[];
  raw: string;
  source: 'cli' | 'api' | 'stub';
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    p.on('error', (e) => resolve({ code: -1, out, err: err + '\n' + e.message }));
  });
}

export class AppInspectService {
  cliAvailable(): boolean {
    try {
      const res = spawnSync('splunk-appinspect', ['--version'], { encoding: 'utf-8' });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  async inspectTarball(tarballPath: string): Promise<AppInspectReport> {
    const abs = path.resolve(tarballPath);
    await fs.access(abs);

    if (this.cliAvailable()) {
      return this.inspectViaCli(abs);
    }
    if (process.env.APPINSPECT_TOKEN) {
      return this.inspectViaApi(abs);
    }
    return {
      summary: { skipped: 1 },
      checks: [],
      raw:
        'AppInspect skipped: neither the `splunk-appinspect` CLI nor APPINSPECT_TOKEN env var are available. ' +
        'Install with `pip install splunk-appinspect` or export APPINSPECT_TOKEN.',
      source: 'stub',
    };
  }

  private async inspectViaCli(abs: string): Promise<AppInspectReport> {
    const res = await run('splunk-appinspect', [
      'inspect', abs,
      '--output-file', '/tmp/appinspect.json',
      '--mode', 'precert',
    ]);
    const raw = (res.out + '\n' + res.err).trim();
    let summary: Record<string, number> = {};
    let checks: AppInspectCheck[] = [];
    try {
      const text = await fs.readFile('/tmp/appinspect.json', 'utf-8');
      const parsed = JSON.parse(text) as {
        summary?: Record<string, number>;
        reports?: Array<{ groups: Array<{ checks: Array<AppInspectCheck> }> }>;
      };
      if (parsed.summary) summary = parsed.summary;
      for (const report of parsed.reports ?? []) {
        for (const group of report.groups) {
          for (const c of group.checks) checks.push(c);
        }
      }
    } catch {
      // Report file missing — leave empty.
    }
    return { summary, checks, raw, source: 'cli' };
  }

  private async inspectViaApi(abs: string): Promise<AppInspectReport> {
    const token = process.env.APPINSPECT_TOKEN!;
    const buf = await fs.readFile(abs);
    const form = new FormData();
    form.append('app_package', new Blob([buf]), path.basename(abs));
    const submitRes = await fetch('https://appinspect.splunk.com/v1/app/validate', {
      method: 'POST',
      headers: { Authorization: `bearer ${token}` },
      body: form as unknown as BodyInit,
    });
    if (!submitRes.ok) {
      throw new Error(`AppInspect submit failed: ${submitRes.status} ${submitRes.statusText}`);
    }
    const submit = await submitRes.json() as { request_id: string };
    // Poll.
    const start = Date.now();
    while (Date.now() - start < 300_000) {
      await new Promise((r) => setTimeout(r, 5000));
      const statusRes = await fetch(
        `https://appinspect.splunk.com/v1/app/validate/status/${submit.request_id}`,
        { headers: { Authorization: `bearer ${token}` } },
      );
      const status = await statusRes.json() as { status: string };
      if (status.status === 'SUCCESS') break;
      if (status.status === 'ERROR') throw new Error('AppInspect status=ERROR');
    }
    const reportRes = await fetch(
      `https://appinspect.splunk.com/v1/app/report/${submit.request_id}`,
      {
        headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
      },
    );
    const report = await reportRes.json() as {
      summary: Record<string, number>;
      reports: Array<{ groups: Array<{ checks: AppInspectCheck[] }> }>;
    };
    const checks: AppInspectCheck[] = [];
    for (const r of report.reports) for (const g of r.groups) for (const c of g.checks) checks.push(c);
    return { summary: report.summary, checks, raw: JSON.stringify(report.summary), source: 'api' };
  }

  summarise(report: AppInspectReport): string {
    const parts: string[] = [];
    parts.push(`AppInspect (${report.source}):`);
    if (Object.keys(report.summary).length) {
      parts.push(
        Object.entries(report.summary)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n'),
      );
    }
    const failures = report.checks.filter((c) => c.result === 'failure' || c.result === 'error');
    if (failures.length) {
      parts.push('Failures:');
      for (const f of failures.slice(0, 20)) {
        parts.push(`  - ${f.check}: ${f.message}`);
      }
    }
    if (!failures.length && !Object.keys(report.summary).length) {
      parts.push(report.raw);
    }
    return parts.join('\n');
  }
}
