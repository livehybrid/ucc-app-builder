import { Tool } from '../toolTypes';
import { confSpecIndex } from '../../confSpec';

/**
 * Agent-facing tools for Splunk `.conf.spec` lookup. These hit the
 * in-memory `confSpecIndex`, which is populated by the server at startup from
 * the bundled Splunk 10.2 specs.
 *
 * Client-side fallback: if the index is empty (dev mode, server not reachable),
 * we call `/api/confspec/*` and cache the result.
 */

async function serverFetchStanza(conf: string, stanza: string): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/confspec/stanza?conf=${encodeURIComponent(conf)}&stanza=${encodeURIComponent(stanza)}`
    );
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function serverListStanzas(conf: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/confspec/stanzas?conf=${encodeURIComponent(conf)}`);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function formatStanza(confName: string, stanzaName: string) {
  const stanza = confSpecIndex.getStanza(confName, stanzaName);
  if (!stanza) return null;
  const lines: string[] = [];
  lines.push(`# ${confName} — [${stanza.name}]`);
  if (stanza.doc) lines.push(stanza.doc, '');
  if (!stanza.settings.length) {
    lines.push('(no settings documented)');
  } else {
    for (const s of stanza.settings) {
      lines.push(`${s.name} = ${s.rhs}`);
      if (s.default) lines.push(`  default: ${s.default}`);
      if (s.doc) {
        const docLines = s.doc.split('\n').map((d) => `  ${d}`);
        lines.push(...docLines);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

export const getStanzaSpec: Tool = {
  name: 'get_stanza_spec',
  description:
    'Look up the Splunk `.conf.spec` entry for a given stanza. Returns the stanza description, all settings, their types, defaults, and docs. ' +
    'Always prefer this over web search when choosing what keys to put in a .conf file.',
  parameters: {
    type: 'object',
    properties: {
      conf: {
        type: 'string',
        description: 'Conf file name, e.g. "inputs.conf" or "props.conf".',
      },
      stanza: {
        type: 'string',
        description: 'Stanza name or prefix, e.g. "script://" or "default".',
      },
    },
    required: ['conf', 'stanza'],
  },
  execute: async (args) => {
    const conf = String(args.conf);
    const stanza = String(args.stanza);

    const formatted = formatStanza(conf, stanza);
    if (formatted) return formatted;

    // Fallback to server.
    const fromServer = await serverFetchStanza(conf, stanza);
    if (fromServer) return fromServer;

    const known = confSpecIndex.listConfs();
    return known.length
      ? `Stanza "${stanza}" not found in ${conf}. Available confs: ${known.join(', ')}`
      : `Spec index empty. Register specs at startup or ensure /api/confspec/ is reachable.`;
  },
};

export const listStanzas: Tool = {
  name: 'list_stanzas',
  description: 'List the stanza names defined in a given `.conf.spec` file.',
  parameters: {
    type: 'object',
    properties: {
      conf: { type: 'string', description: 'Conf file name, e.g. "inputs.conf".' },
    },
    required: ['conf'],
  },
  execute: async (args) => {
    const conf = String(args.conf);
    const local = confSpecIndex.listStanzas(conf);
    if (local && local.length) {
      return `Stanzas in ${conf}:\n${local.map((s) => `  [${s}]`).join('\n')}`;
    }
    const fromServer = await serverListStanzas(conf);
    if (fromServer) return fromServer;
    return `No stanzas found for ${conf}.`;
  },
};
