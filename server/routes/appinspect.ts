import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { builds } from './build.js';
import { augmentedEnv } from '../utils/env.js';

const router = Router();

export type DeploymentTarget =
  | 'splunkbase'
  | 'cloud_victoria'
  | 'cloud_classic'
  | 'enterprise';

export type OutputFormat = 'json' | 'junitxml';

const TARGET_TAGS: Record<DeploymentTarget, { included: string[]; excluded: string[] }> = {
  splunkbase:      { included: ['splunk_appinspect'], excluded: [] },
  cloud_victoria:  { included: ['private_victoria'],  excluded: [] },
  cloud_classic:   { included: ['private_classic'],   excluded: [] },
  enterprise:      { included: ['splunk_appinspect'], excluded: ['cloud'] },
};

export interface AppInspectCheck {
  name: string;
  description: string;
  result: 'success' | 'failure' | 'warning' | 'skipped' | 'error' | 'not_applicable';
  tags: string[];
  messages: Array<{
    filename?: string;
    line?: number;
    message: string;
    result: string;
  }>;
}

export interface AppInspectReport {
  summary: {
    Status: string;
    failure: number;
    warning: number;
    success: number;
    skipped: number;
    error: number;
    not_applicable?: number;
  };
  checks: AppInspectCheck[];
  rawOutput?: string;
}

function parseJsonReport(raw: string): AppInspectReport {
  const data = JSON.parse(raw);
  const summary = data.summary ?? {};
  const checks: AppInspectCheck[] = [];

  for (const report of data.reports ?? []) {
    for (const group of report.groups ?? []) {
      for (const check of group.checks ?? []) {
        checks.push({
          name: check.name ?? '',
          description: check.description ?? '',
          result: check.result ?? 'skipped',
          tags: check.tags ?? [],
          messages: (check.messages ?? []).map((m: Record<string, unknown>) => ({
            filename: m.filename as string | undefined,
            line: m.line as number | undefined,
            message: String(m.message ?? ''),
            result: String(m.result ?? ''),
          })),
        });
      }
    }
  }

  return { summary, checks };
}

/**
 * POST /api/appinspect/run
 * Run splunk-appinspect against a previously built app package.
 *
 * Body: { buildId: string, target: DeploymentTarget, outputFormat: OutputFormat }
 */
router.post('/appinspect/run', async (req: Request, res: Response) => {
  const { buildId, target = 'splunkbase', outputFormat = 'json' } = req.body as {
    buildId?: string;
    target?: DeploymentTarget;
    outputFormat?: OutputFormat;
  };

  if (!buildId) return res.status(400).json({ error: 'buildId is required' });

  const build = builds.get(buildId);
  if (!build) return res.status(404).json({ error: `Build ${buildId} not found` });
  if (build.status !== 'success') {
    return res.status(400).json({ error: `Build is not complete (status: ${build.status})` });
  }
  if (!build.outputPath) {
    return res.status(400).json({ error: 'Build has no output package' });
  }

  const tags = TARGET_TAGS[target] ?? TARGET_TAGS.splunkbase;
  const tmpFile = path.join(os.tmpdir(), `appinspect-${buildId}.${outputFormat === 'junitxml' ? 'xml' : 'json'}`);

  const args = [
    'inspect',
    build.outputPath,
    '--mode', 'precert',
    '--data-format', outputFormat === 'junitxml' ? 'junitxml' : 'json',
    '--output-file', tmpFile,
    '--max-messages', 'all',
    '--log-level', 'CRITICAL',
    '--skip-trusted-libraries-update',
  ];
  for (const tag of tags.included) args.push('--included-tags', tag);
  for (const tag of tags.excluded) args.push('--excluded-tags', tag);

  try {
    await runAppInspect(args);
  } catch (err) {
    // exit code 1/101/103/104 are "checks ran but found issues" — still readable output
    const code = (err as { code?: number }).code ?? 0;
    if (code === 2) {
      return res.status(500).json({ error: `AppInspect encountered an internal exception (exit ${code})` });
    }
    // codes 0,1,3,101,103,104 all produce valid output files — fall through
  }

  let raw: string;
  try {
    raw = await fs.readFile(tmpFile, 'utf-8');
  } catch {
    return res.status(500).json({ error: 'AppInspect did not produce output — is splunk-appinspect installed?' });
  } finally {
    fs.unlink(tmpFile).catch(() => {});
  }

  if (outputFormat === 'junitxml') {
    res.setHeader('Content-Type', 'application/xml');
    return res.send(raw);
  }

  // Parse JSON and return structured report
  try {
    const report = parseJsonReport(raw);
    res.json(report);
  } catch {
    res.status(500).json({ error: 'Failed to parse AppInspect JSON output', rawOutput: raw.slice(0, 2000) });
  }
});

/**
 * GET /api/appinspect/available
 * Check whether splunk-appinspect is installed.
 */
router.get('/appinspect/available', async (_req: Request, res: Response) => {
  try {
    await runAppInspect(['--help']);
    res.json({ available: true });
  } catch (err) {
    res.json({ available: false, reason: err instanceof Error ? err.message : String(err) });
  }
});

// Exit codes that indicate appinspect ran (even if checks failed) vs. a hard error.
// 0 = all pass, 1 = packaging failure, 3 = check error, 101 = failures, 103 = warnings, 104 = future failures
const APPINSPECT_OK_CODES = new Set([0, 1, 3, 101, 103, 104]);

function runAppInspect(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('splunk-appinspect', args, { stdio: 'pipe', env: augmentedEnv() });
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      const exitCode = code ?? 0;
      if (APPINSPECT_OK_CODES.has(exitCode)) {
        resolve();
      } else {
        const err = new Error(`splunk-appinspect exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ''}`);
        (err as unknown as { code: number }).code = exitCode;
        reject(err);
      }
    });
    proc.on('error', (err) => reject(err));
  });
}

export { router as appInspectRouter };
