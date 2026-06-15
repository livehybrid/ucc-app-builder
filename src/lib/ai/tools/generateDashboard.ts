import { Tool } from '../toolTypes';

const API_BASE =
  (window as unknown as { __UCC_API_BASE__?: string }).__UCC_API_BASE__ || '/api';

function appIdOf(vfs: { getAllFiles(): Array<{ path: string; content: string }> }): string {
  const files = vfs.getAllFiles();
  const gc = files.find((f) => f.path.endsWith('globalConfig.json'));
  if (gc) {
    try {
      const id = JSON.parse(gc.content)?.meta?.name;
      if (id) return String(id);
    } catch {
      /* fall through */
    }
  }
  const first = files[0];
  return first ? first.path.replace(/^\/+/, '').split('/')[0] : 'TA_app';
}

/**
 * Generate a Dashboard Studio (v2) dashboard from a structured spec and write it into the
 * project. Also exposed as the `ucc_generate_dashboard` Splunk MCP tool, so external agents
 * (Splunk AI Assistant, Claude Desktop) can use the same generator.
 */
export const generateDashboard: Tool = {
  name: 'generate_dashboard',
  description:
    'Generate a Dashboard Studio (v2) dashboard. Args: title, panels:[{title, spl, viz}], ' +
    'optional description, theme. viz ∈ line|area|column|bar|table|single|pie|scatter|map. ' +
    'Ground SPL in real indexes/sourcetypes. timechart+line for trends; stats/top+bar/column/' +
    'table for breakdowns; single for KPIs. Writes default/data/ui/views/<name>.xml.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Dashboard title.' },
      description: { type: 'string' },
      panels: {
        type: 'array',
        description: 'Panels: [{title, spl, viz}].',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            spl: { type: 'string' },
            viz: { type: 'string' },
          },
        },
      },
      theme: { type: 'string', description: 'light or dark (default dark).' },
    },
    required: ['title', 'panels'],
  },
  execute: async (args, vfs) => {
    try {
      const res = await fetch(`${API_BASE}/generate/dashboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const d = (await res.json()) as { ok?: boolean; path?: string; content?: string; error?: string };
      if (!d.ok || !d.path || !d.content) return `Error: ${d.error || 'dashboard generation failed'}`;
      const full = `${appIdOf(vfs)}/${d.path}`;
      vfs.writeFile(full, d.content, 'user');
      return `Created Dashboard Studio dashboard at ${full}.`;
    } catch (e) {
      return `Error generating dashboard: ${(e as Error).message}`;
    }
  },
};
