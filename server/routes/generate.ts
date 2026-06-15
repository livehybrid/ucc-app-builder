/**
 * Artifact generation endpoints behind the `generate_dashboard` / `generate_savedsearch`
 * MCP tools (and our own assistant's tools). Stateless: they emit the exact Dashboard Studio
 * view XML / savedsearches.conf stanza from a structured spec; the caller writes it into the
 * project (the Splunk MCP handler → KV; the browser tool → VFS).
 */
import { Router, Request, Response } from 'express';
import {
  buildDashboardViewXml,
  viewFileName,
  buildSavedSearchStanza,
  type DashboardSpec,
  type SavedSearchSpec,
} from '../../src/lib/splunkArtifacts.js';

const router = Router();

/** The Splunk MCP server may pass nested args as JSON strings; accept both. */
function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}
function asObject(v: unknown): unknown {
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return v;
}

router.post('/generate/dashboard', (req: Request, res: Response) => {
  const { title, description, theme } = req.body ?? {};
  const panels = asArray(req.body?.panels);
  if (!title || panels.length === 0) {
    return res.status(400).json({ ok: false, error: 'title and a non-empty panels[] are required' });
  }
  try {
    const content = buildDashboardViewXml({ title, description, panels, theme } as DashboardSpec);
    const fileName = viewFileName(String(title));
    res.json({
      ok: true,
      fileName,
      path: `package/default/data/ui/views/${fileName}`,
      content,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

router.post('/generate/savedsearch', (req: Request, res: Response) => {
  const { name, search } = req.body ?? {};
  if (!name || !search) {
    return res.status(400).json({ ok: false, error: 'name and search are required' });
  }
  try {
    const spec = { ...req.body, alert: asObject(req.body?.alert) } as SavedSearchSpec;
    const stanza = buildSavedSearchStanza(spec);
    res.json({ ok: true, stanza, path: 'package/default/savedsearches.conf' });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

export { router as generateRouter };
