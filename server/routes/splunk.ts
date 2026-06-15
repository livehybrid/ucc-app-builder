import { Router, Request, Response } from 'express';
import { splunkMcp } from '../services/splunkMcp.js';

/**
 * CONSUME-side Splunk MCP endpoints. The wizard calls these to ground add-on
 * generation in the live instance (real indexes / sourcetypes) instead of
 * making the user guess. Backed by the Splunk MCP Server's splunk_get_indexes /
 * splunk_get_metadata / saia_generate_spl tools.
 */
const router = Router();

router.get('/splunk/status', (_req: Request, res: Response) => {
  res.json({
    configured: splunkMcp.configured(),
    note: splunkMcp.configured()
      ? 'Splunk MCP configured — wizard suggestions are grounded in the live instance.'
      : 'Set SPLUNK_MCP_URL and SPLUNK_TOKEN to ground suggestions in a live Splunk instance.',
  });
});

router.get('/splunk/indexes', async (_req: Request, res: Response) => {
  try {
    const indexes = await splunkMcp.getIndexes();
    res.json({ ok: true, indexes });
  } catch (err) {
    res.status(splunkMcp.configured() ? 502 : 400).json({ ok: false, error: (err as Error).message });
  }
});

router.get('/splunk/sourcetypes', async (req: Request, res: Response) => {
  const index = typeof req.query.index === 'string' ? req.query.index : undefined;
  try {
    const sourcetypes = await splunkMcp.getSourcetypes(index);
    res.json({ ok: true, index: index ?? null, sourcetypes });
  } catch (err) {
    res.status(splunkMcp.configured() ? 502 : 400).json({ ok: false, error: (err as Error).message });
  }
});

router.post('/splunk/generate-spl', async (req: Request, res: Response) => {
  const question = String(req.body?.question ?? '').trim();
  if (!question) return res.status(400).json({ ok: false, error: 'question is required' });
  try {
    const spl = await splunkMcp.generateSpl(question);
    res.json({ ok: true, spl });
  } catch (err) {
    res.status(splunkMcp.configured() ? 502 : 400).json({ ok: false, error: (err as Error).message });
  }
});

export { router as splunkRouter };
