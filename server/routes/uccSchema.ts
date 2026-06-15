import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';

export const uccSchemaRouter = Router();

/**
 * Serve the AUTHORITATIVE globalConfig JSON schema, extracted from the
 * installed splunk-add-on-ucc-framework package — the exact schema the
 * ucc-gen that builds this app validates against. The editor uses it for
 * Monaco JSON diagnostics, so editor validation is always in lockstep with
 * the build engine, with no manually-synced schema copy to go stale.
 */

const LOCATOR = `
import json, os
import splunk_add_on_ucc_framework as ucc
try:
    from importlib.metadata import version
    v = version("splunk_add_on_ucc_framework")
except Exception:
    v = getattr(ucc, "__version__", "unknown")
print(json.dumps({
    "schemaPath": os.path.join(os.path.dirname(ucc.__file__), "schema", "schema.json"),
    "uccVersion": v,
}))
`;

let cache: { schema: unknown; uccVersion: string } | null = null;

function locate(): Promise<{ schemaPath: string; uccVersion: string }> {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', ['-c', LOCATOR], { timeout: 10000 });
    let out = '';
    let err = '';
    py.stdout.on('data', (d) => (out += String(d)));
    py.stderr.on('data', (d) => (err += String(d)));
    py.on('error', reject);
    py.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.slice(0, 300) || `python exited ${code}`));
      try {
        resolve(JSON.parse(out.trim()));
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}

uccSchemaRouter.get('/ucc/schema', async (_req: Request, res: Response) => {
  if (cache) {
    res.json(cache);
    return;
  }
  try {
    const { schemaPath, uccVersion } = await locate();
    const schema = JSON.parse(await readFile(schemaPath, 'utf-8'));
    cache = { schema, uccVersion };
    res.json(cache);
  } catch (e) {
    // ucc-gen not installed where the server runs — the editor falls back to
    // its bundled subset schema.
    res.status(404).json({ error: `UCC schema unavailable: ${(e as Error).message}` });
  }
});

/** Test hook. */
export function __resetUccSchemaCache(): void {
  cache = null;
}
