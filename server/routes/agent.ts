import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import { UCCGenService } from '../services/uccGen.js';
import { FileHandler } from '../utils/fileHandler.js';
import { SplunkDockerService } from '../services/splunkDocker.js';
import { AppInspectService } from '../services/appInspect.js';
import { traceLogger } from '../services/traceLogger.js';
import { runAgentLoop, LoopEvent } from '../services/agentLoop.js';

/**
 * Endpoints that back agent-callable tools for the end-to-end "build → install
 * → verify" loop the user asked for. Kept separate from `build.ts` so the
 * human-initiated build flow is undisturbed.
 */

const router = Router();
const uccGen = new UCCGenService();
const fileHandler = new FileHandler();
const splunkDocker = new SplunkDockerService();
const appInspect = new AppInspectService();

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

const DOCKER_TOOLS_ENABLED = envFlag('UCC_ENABLE_DOCKER_TOOLS', false);
const BROWSER_CHECK_ENABLED = envFlag('UCC_ENABLE_BROWSER_CHECK', false);

/** Build artifacts the agent has produced during a session. Keyed by sessionId. */
const artifacts = new Map<string, { tarball: string; appId: string; builtAt: string }>();

router.post('/agent/ucc-gen', async (req: Request, res: Response) => {
  const { sessionId, files, appId, version } = req.body ?? {};
  if (!sessionId || !Array.isArray(files) || !appId) {
    return res.status(400).json({ error: 'sessionId, files, appId are required' });
  }

  const start = Date.now();
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);

  try {
    const workDir = await fileHandler.createTempDirectory(`agent-${sessionId}-${uuidv4()}`);
    await fileHandler.writeFiles(workDir, files);
    await uccGen.init(workDir, appId, log);
    const outputDir = await uccGen.build(workDir, log, version ?? '1.0.0');
    const builtAppPath = path.join(outputDir, appId);
    const tarball = await uccGen.package(workDir, builtAppPath, log);
    artifacts.set(sessionId, {
      tarball,
      appId,
      builtAt: new Date().toISOString(),
    });
    await traceLogger.log({
      sessionId,
      kind: 'tool_result',
      name: 'run_ucc_gen',
      durationMs: Date.now() - start,
      payload: { ok: true, tarball, appId },
    });
    res.json({ ok: true, tarball, appId, logs });
  } catch (err) {
    const msg = (err as Error).message;
    await traceLogger.log({
      sessionId,
      kind: 'error',
      name: 'run_ucc_gen',
      durationMs: Date.now() - start,
      payload: { error: msg, logs: logs.slice(-50) },
    });
    res.status(500).json({ ok: false, error: msg, logs });
  }
});

router.get('/agent/artifact', (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId ?? '');
  const artifact = artifacts.get(sessionId);
  if (!artifact) return res.status(404).json({ error: 'no build artifact for session' });
  res.json(artifact);
});

router.post('/agent/appinspect', async (req: Request, res: Response) => {
  const { sessionId } = req.body ?? {};
  const artifact = artifacts.get(sessionId);
  if (!artifact) return res.status(400).json({ error: 'Run run_ucc_gen first.' });
  const start = Date.now();
  try {
    const report = await appInspect.inspectTarball(artifact.tarball);
    await traceLogger.log({
      sessionId,
      kind: 'tool_result',
      name: 'run_appinspect',
      durationMs: Date.now() - start,
      payload: { summary: report.summary, source: report.source },
    });
    res.json({ ok: true, report, summary: appInspect.summarise(report) });
  } catch (err) {
    const msg = (err as Error).message;
    await traceLogger.log({
      sessionId, kind: 'error', name: 'run_appinspect',
      durationMs: Date.now() - start,
      payload: { error: msg },
    });
    res.status(500).json({ ok: false, error: msg });
  }
});

router.post('/agent/install-docker', async (req: Request, res: Response) => {
  if (!DOCKER_TOOLS_ENABLED) {
    return res.status(403).json({
      ok: false,
      error:
        'Docker install tooling is disabled for this deployment. ' +
        'Set UCC_ENABLE_DOCKER_TOOLS=true only in testing/self-hosted environments.',
    });
  }

  const { sessionId, password, webPort, mgmtPort, containerName } = req.body ?? {};
  const artifact = artifacts.get(sessionId);
  if (!artifact) return res.status(400).json({ error: 'Run run_ucc_gen first.' });

  if (!splunkDocker.isDockerAvailable()) {
    return res.status(503).json({
      ok: false,
      error: 'Docker is not available on this host. Install Docker Desktop / CLI and retry.',
    });
  }

  const start = Date.now();
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);

  try {
    const name = await splunkDocker.ensureContainer({
      containerName, password, webPort, mgmtPort, onLog: log,
    });
    await splunkDocker.waitForReady(name, log);
    await splunkDocker.installApp(name, artifact.tarball, artifact.appId, log);
    const tail = await splunkDocker.tailInternalLog(name);
    const errors = splunkDocker.extractErrors(tail);
    await traceLogger.log({
      sessionId, kind: 'tool_result', name: 'install_to_splunk_docker',
      durationMs: Date.now() - start,
      payload: { errors: errors.slice(0, 10), containerName: name },
    });
    res.json({
      ok: errors.length === 0,
      containerName: name,
      webUrl: `http://localhost:${webPort ?? 8000}/en-US/app/${artifact.appId}`,
      logs,
      errors,
    });
  } catch (err) {
    const msg = (err as Error).message;
    await traceLogger.log({
      sessionId, kind: 'error', name: 'install_to_splunk_docker',
      durationMs: Date.now() - start,
      payload: { error: msg, logs: logs.slice(-30) },
    });
    res.status(500).json({ ok: false, error: msg, logs });
  }
});

router.post('/agent/browser-check', async (req: Request, res: Response) => {
  if (!BROWSER_CHECK_ENABLED) {
    return res.status(403).json({
      ok: false,
      error:
        'Browser check tooling is disabled for this deployment. ' +
        'Set UCC_ENABLE_BROWSER_CHECK=true where Playwright checks are allowed.',
    });
  }

  const { sessionId, url, expectTexts } = req.body ?? {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  const start = Date.now();
  try {
    // We invoke Playwright via a child process to avoid pulling the full test
    // runner into the server bundle. The script lives next to us.
    const script = path.join(process.cwd(), 'server/scripts/browser-check.mjs');
    try { await fs.access(script); } catch {
      return res.status(501).json({
        ok: false,
        error: `browser-check script missing at ${script}. Install playwright and run \`npm run test:e2e:install\`.`,
      });
    }
    const output: string[] = [];
    const errors: string[] = [];
    const code: number = await new Promise((resolve) => {
      const p = spawn('node', [script, url, ...(expectTexts ?? [])], {
        env: { ...process.env },
      });
      p.stdout.on('data', (d) => output.push(d.toString()));
      p.stderr.on('data', (d) => errors.push(d.toString()));
      p.on('close', (c) => resolve(c ?? -1));
    });
    await traceLogger.log({
      sessionId: sessionId ?? 'no-session',
      kind: 'tool_result',
      name: 'browser_check',
      durationMs: Date.now() - start,
      payload: { ok: code === 0, url, expectTexts },
    });
    res.json({
      ok: code === 0,
      stdout: output.join(''),
      stderr: errors.join(''),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * POST /api/agent/build-loop
 * The keystone agentic loop: generate (ucc-gen) -> appinspect -> auto-fix -> repeat.
 * Streams loop events over SSE. Body: { sessionId, appId, files, version?, maxIterations?,
 * includeWarnings?, useLlm? }.
 */
router.post('/agent/build-loop', async (req: Request, res: Response) => {
  const { sessionId, appId, files, version, maxIterations, includeWarnings, useLlm, llmOnly } = req.body ?? {};
  if (!sessionId || !appId || !Array.isArray(files)) {
    return res.status(400).json({ error: 'sessionId, appId, files[] are required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await runAgentLoop({
      sessionId,
      appId,
      files,
      version,
      maxIterations,
      includeWarnings,
      useLlm,
      llmOnly,
      onEvent: (e: LoopEvent) => send('loop', e),
    });
    send('result', result);
  } catch (err) {
    send('error', { error: (err as Error).message });
  } finally {
    res.end();
  }
});

/**
 * POST /api/agent/build-loop/sync
 * Same loop, but returns the full result as one JSON response (no streaming).
 * Convenient for the MCP `validate_app` tool and for scripting.
 */
router.post('/agent/build-loop/sync', async (req: Request, res: Response) => {
  const { sessionId, appId, files, version, maxIterations, includeWarnings, useLlm, llmOnly } = req.body ?? {};
  if (!sessionId || !appId || !Array.isArray(files)) {
    return res.status(400).json({ error: 'sessionId, appId, files[] are required' });
  }
  try {
    const result = await runAgentLoop({
      sessionId, appId, files, version, maxIterations, includeWarnings, useLlm, llmOnly,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.get('/agent/traces', async (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId ?? '');
  if (!sessionId) {
    const sessions = await traceLogger.listSessions();
    return res.json({ sessions });
  }
  const events = await traceLogger.read(sessionId);
  res.json({ sessionId, events });
});

export { router as agentRouter };
