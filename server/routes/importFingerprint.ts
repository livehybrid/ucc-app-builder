/**
 * Import fingerprinting via ucc-gen.
 * Runs ucc-gen on a minimal temp source (globalConfig.json only) and returns
 * sha256 checksums of every generated output file.  The browser then compares
 * these against the imported app's file checksums to distinguish truly-generated
 * files from user-modified ones.
 */

import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { augmentedEnv } from '../utils/env.js';

const router = Router();
const UCC_GEN_PATH = process.env.UCC_GEN_PATH || 'ucc-gen';

function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function hashDir(dir: string, root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      Object.assign(out, await hashDir(full, root));
    } else if (e.isFile()) {
      const rel = path.relative(root, full).replace(/\\/g, '/');
      const buf = await fs.readFile(full);
      out[rel] = sha256Buffer(buf);
    }
  }
  return out;
}

function runCmd(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(UCC_GEN_PATH, args, { cwd, env: augmentedEnv(), stdio: 'pipe' });
    const stderr: string[] = [];
    proc.stderr.on('data', (d: Buffer) => stderr.push(d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ucc-gen exited ${code}: ${stderr.join('').slice(0, 400)}`));
    });
    proc.on('error', (err) => reject(err));
  });
}

async function isAvailable(): Promise<boolean> {
  try {
    await runCmd(['--help'], os.tmpdir());
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /api/import/fingerprint
 *
 * Body: { globalConfig: object|string, appId: string }
 * Response: { available: boolean, fingerprints: Record<string, string> }
 *
 * Fingerprints are keyed as "<appId>/<relative-path>" to match the path
 * format used by the import analysis.
 */
router.post('/import/fingerprint', async (req: Request, res: Response) => {
  const { globalConfig, appId } = req.body as { globalConfig: unknown; appId: string };

  if (!globalConfig || !appId) {
    return res.status(400).json({ error: 'globalConfig and appId are required' });
  }

  if (!(await isAvailable())) {
    return res.json({ available: false, fingerprints: {} });
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ucc-fp-'));
  try {
    const packageDir = path.join(tmpDir, 'package');
    await fs.mkdir(packageDir, { recursive: true });

    const configStr =
      typeof globalConfig === 'string' ? globalConfig : JSON.stringify(globalConfig);
    await fs.writeFile(path.join(packageDir, 'globalConfig.json'), configStr, 'utf-8');

    // Minimal app.manifest so ucc-gen doesn't fail validation
    let parsedMeta: { name?: string; displayName?: string; version?: string } = {};
    try {
      const parsed = JSON.parse(configStr) as { meta?: typeof parsedMeta };
      parsedMeta = parsed.meta ?? {};
    } catch { /* ignore */ }

    const manifest = {
      schemaVersion: '2.0.0',
      info: {
        title: parsedMeta.displayName || appId,
        id: { group: null, name: parsedMeta.name || appId, version: parsedMeta.version || '1.0.0' },
        author: [{ name: 'fingerprint', email: '' }],
        description: '',
        license: { name: '', uri: '' },
      },
      supportedDeployments: ['_standalone'],
      targetWorkloads: ['_search_heads'],
    };
    await fs.writeFile(
      path.join(packageDir, 'app.manifest'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    const outputDir = path.join(tmpDir, 'output');
    await fs.mkdir(outputDir, { recursive: true });

    await runCmd(['build', '--source', packageDir, '--output', outputDir], tmpDir);

    // Output lands in outputDir/<appName>/ — find whichever dir ucc-gen created
    const outputEntries = await fs.readdir(outputDir, { withFileTypes: true });
    const appDir = outputEntries.find((e) => e.isDirectory());
    if (!appDir) {
      return res.json({ available: true, fingerprints: {} });
    }

    const appOutputDir = path.join(outputDir, appDir.name);
    const hashes = await hashDir(appOutputDir, appOutputDir);

    // Prefix with the actual imported appId so paths match the analysis
    const fingerprints: Record<string, string> = {};
    for (const [rel, hash] of Object.entries(hashes)) {
      fingerprints[`${appId}/${rel}`] = hash;
    }

    return res.json({ available: true, fingerprints });
  } catch (err) {
    console.error('[fingerprint] error:', err);
    // Return partial/empty fingerprints rather than a hard error — UI degrades gracefully
    return res.json({
      available: true,
      fingerprints: {},
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
  }
});

export { router as importFingerprintRouter };
