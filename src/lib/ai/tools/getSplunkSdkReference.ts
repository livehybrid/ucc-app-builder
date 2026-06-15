import { Tool } from '../toolTypes';
import { formatSplunkSdkEntries, searchSplunkSdkReference } from '../../splunkSdkReference';

export const getSplunkSdkReference: Tool = {
  name: 'get_splunk_sdk_reference',
  description:
    'Look up Splunk Python SDK/UCC helper symbols with signatures and usage notes. Use this before writing Python code.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Symbol, module, or API concept (e.g. Script, StreamingCommand, BaseModInput, checkpointer).',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of matches to return (default 8, max 20).',
      },
    },
    required: ['query'],
  },
  execute: async (args) => {
    const query = String(args.query || '').trim();
    const requestedLimit = Number(args.limit ?? 8);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(20, requestedLimit)) : 8;

    const matches = searchSplunkSdkReference(query, limit);
    if (!matches.length) {
      return `No SDK reference matches found for "${query}". Try a broader query like "modularinput", "searchcommands", "BaseModInput", or "checkpointer".`;
    }

    return `Splunk SDK reference matches for "${query}":\n\n${formatSplunkSdkEntries(matches)}`;
  },
};
