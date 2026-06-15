import { Tool } from '../toolTypes';

export const consultDocumentation: Tool = {
  name: 'consult_documentation',
  description:
    'Search technical documentation for Splunk/UCC/Python details. Uses local FlexSearch index first (specs/docs/examples), then optional external context service.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query (e.g., "how to configure oauth in ucc")',
      },
    },
    required: ['query'],
  },
  execute: async (args, _vfs) => {
    const query = args.query as string;

    try {
      const response = await fetch('/api/ai/context', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        return 'Documentation search unavailable right now. Try get_stanza_spec/get_splunk_sdk_reference for deterministic local knowledge.';
      }

      const data = await response.json();
      return JSON.stringify(data, null, 2);
    } catch (e: unknown) {
      return `Error consulting documentation: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};
