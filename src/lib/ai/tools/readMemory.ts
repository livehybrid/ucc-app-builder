import { Tool } from '../toolTypes';
import { sessionState } from '../sessionState';

export const readMemory: Tool = {
  name: 'read_memory',
  description:
    'Read the agent scratchpad memory for this session. Use to recall prior tool outputs, decisions, or user-supplied facts. ' +
    'Pass no arguments to dump everything, or a `key` to fetch a single entry.',
  parameters: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Optional. The specific memory key to fetch.',
      },
    },
  },
  execute: async (args) => {
    const key = args.key as string | undefined;
    if (key) {
      const val = sessionState.getMemory(key);
      if (val === undefined) {
        const keys = sessionState.listMemoryKeys();
        return keys.length
          ? `No memory entry for "${key}". Known keys: ${keys.join(', ')}`
          : `No memory entry for "${key}" (memory is empty).`;
      }
      return val;
    }
    return sessionState.summary();
  },
};

export const writeMemory: Tool = {
  name: 'write_memory',
  description:
    'Save a small fact (<=4KB) to the agent scratchpad so it is recalled on the next turn. Ideal for "I discovered endpoint X returns Y" or "the user confirmed credentials are named Z".',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Short stable key.' },
      value: { type: 'string', description: 'Fact to remember.' },
    },
    required: ['key', 'value'],
  },
  execute: async (args) => {
    const key = args.key as string;
    const value = args.value as string;
    if (!key || value === undefined) return 'Error: key and value are required.';
    if (value.length > 4096) {
      return `Error: value too long (${value.length} chars, max 4096). Summarise first.`;
    }
    sessionState.setMemory(key, value);
    return `Saved memory["${key}"] (${value.length} chars).`;
  },
};
