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
 * Generate a savedsearches.conf entry (report or scheduled alert) and append it to the
 * project. Also exposed as the `ucc_generate_savedsearch` Splunk MCP tool.
 */
export const generateSavedSearch: Tool = {
  name: 'generate_savedsearch',
  description:
    'Generate a savedsearches.conf entry — a report or scheduled alert. Args: name, search (SPL); ' +
    'optional description, earliest, latest, cronSchedule (schedules it), alert={condition, ' +
    'threshold, severity 1-6} for alerting. Ground SPL in real indexes. Appends to ' +
    'default/savedsearches.conf.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      search: { type: 'string', description: 'SPL.' },
      description: { type: 'string' },
      cronSchedule: { type: 'string' },
      earliest: { type: 'string' },
      latest: { type: 'string' },
      alert: { type: 'object', description: '{condition, threshold, severity}' },
    },
    required: ['name', 'search'],
  },
  execute: async (args, vfs) => {
    try {
      const res = await fetch(`${API_BASE}/generate/savedsearch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const d = (await res.json()) as { ok?: boolean; stanza?: string; path?: string; error?: string };
      if (!d.ok || !d.stanza || !d.path) return `Error: ${d.error || 'saved search generation failed'}`;
      const full = `${appIdOf(vfs)}/${d.path}`;
      const existing = vfs.readFile(full) || '';
      const content = existing.trim() ? `${existing.trimEnd()}\n\n${d.stanza}` : d.stanza;
      vfs.writeFile(full, content, 'user');
      return `Added saved search [${(args as { name?: string }).name}] to ${full}.`;
    } catch (e) {
      return `Error generating saved search: ${(e as Error).message}`;
    }
  },
};
