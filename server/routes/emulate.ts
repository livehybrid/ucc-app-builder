/**
 * Input emulator endpoint — run a generated modular input's collection logic the way Splunk
 * would (stub helper + EventWriter, real HTTP) WITHOUT installing the add-on, and return the
 * events it would index. Lets the user see real data before authoring props/transforms.
 *
 * Spawns server/services/inputEmulator.py and exchanges JSON over stdin/stdout.
 */
import { Router, Request, Response } from 'express';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const router = Router();

const HARNESS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'services',
  'inputEmulator.py'
);

function runHarness(input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON || 'python3';
    const proc = spawn(python, [HARNESS], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Emulation timed out.'));
    }, timeoutMs);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (out.trim()) resolve(out);
      else reject(new Error(err.trim() || `emulator exited ${code}`));
    });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

/**
 * POST /api/emulate/input
 * { helperCode, args, index?, proxy?, maxEvents? } → { ok, events, logs, count, truncated }
 */
router.post('/emulate/input', async (req: Request, res: Response) => {
  const { helperCode, args, index, proxy, maxEvents } = req.body ?? {};
  if (!helperCode || typeof helperCode !== 'string') {
    return res.status(400).json({ ok: false, error: 'helperCode is required' });
  }
  const payload = JSON.stringify({
    helperCode,
    args: args ?? {},
    index: index ?? 'main',
    proxy: proxy ?? null,
    maxEvents: Number.isFinite(Number(maxEvents)) ? Number(maxEvents) : 200,
  });
  try {
    const out = await runHarness(payload, 45000);
    // The harness prints exactly one JSON object as its last non-empty line.
    const line =
      out
        .trim()
        .split('\n')
        .reverse()
        .find((l) => l.trim().startsWith('{')) || '{}';
    res.json(JSON.parse(line));
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

export { router as emulateRouter };
