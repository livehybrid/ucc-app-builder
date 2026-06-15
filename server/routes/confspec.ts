import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { confSpecIndex } from '../../src/lib/confSpec.js';

const router = Router();

const SPEC_DIR = process.env.UCC_SPEC_DIR
  || path.join(process.cwd(), 'data/splunk-confs');

let bootPromise: Promise<number> | null = null;

async function bootSpecIndex(): Promise<number> {
  try {
    const entries = await fs.readdir(SPEC_DIR, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.spec')) continue;
      const text = await fs.readFile(path.join(SPEC_DIR, entry.name), 'utf-8');
      confSpecIndex.register(entry.name, text);
      count++;
    }
    return count;
  } catch (err) {
    // Spec dir is optional — log and continue with empty index.
    console.warn(`[confspec] Spec directory not found or unreadable: ${SPEC_DIR}`);
    return 0;
  }
}

/** Boot the index on first hit so we don't slow down startup when unused. */
async function ensureBooted() {
  if (!bootPromise) bootPromise = bootSpecIndex();
  return bootPromise;
}

router.get('/confspec/confs', async (_req: Request, res: Response) => {
  await ensureBooted();
  res.json({ confs: confSpecIndex.listConfs() });
});

router.get('/confspec/stanzas', async (req: Request, res: Response) => {
  await ensureBooted();
  const conf = String(req.query.conf ?? '');
  if (!conf) return res.status(400).json({ error: 'conf is required' });
  const stanzas = confSpecIndex.listStanzas(conf);
  if (!stanzas) return res.status(404).json({ error: `Unknown conf: ${conf}` });
  res.type('text/plain').send(stanzas.map((s) => `[${s}]`).join('\n'));
});

router.get('/confspec/stanza', async (req: Request, res: Response) => {
  await ensureBooted();
  const conf = String(req.query.conf ?? '');
  const stanza = String(req.query.stanza ?? '');
  if (!conf || !stanza) {
    return res.status(400).json({ error: 'conf and stanza are required' });
  }
  const result = confSpecIndex.getStanza(conf, stanza);
  if (!result) return res.status(404).json({ error: `Stanza "${stanza}" not found in ${conf}` });
  const lines: string[] = [];
  lines.push(`# ${conf} — [${result.name}]`);
  if (result.doc) lines.push(result.doc, '');
  for (const s of result.settings) {
    lines.push(`${s.name} = ${s.rhs}`);
    if (s.default) lines.push(`  default: ${s.default}`);
    if (s.doc) lines.push(...s.doc.split('\n').map((d) => `  ${d}`));
    lines.push('');
  }
  res.type('text/plain').send(lines.join('\n'));
});

router.post('/confspec/reload', async (_req: Request, res: Response) => {
  bootPromise = bootSpecIndex();
  const count = await bootPromise;
  res.json({ reloaded: true, count });
});

export { router as confSpecRouter };
