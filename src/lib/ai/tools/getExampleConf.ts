import { Tool } from '../tools';

export const getExampleConf: Tool = {
  name: 'get_example_conf',
  description:
    'Return the factory-default example content of a Splunk .conf file (e.g. "inputs", "app", "commands"). ' +
    'These are the Splunk default stanzas and settings — useful for checking valid option names, ' +
    'default values, and correct stanza format before writing to the VFS. ' +
    'Pass just the base name (e.g. "inputs" or "inputs.conf").',
  parameters: {
    type: 'object',
    required: ['name'],
    properties: {
      name: {
        type: 'string',
        description: 'Conf file base name, e.g. "inputs", "app", "commands", "alert_actions".',
      },
    },
  },
  execute: async (args) => {
    const name = String(args.name ?? '').trim();
    if (!name) return 'Error: name is required';

    try {
      const res = await fetch(`/api/confspec/conf?name=${encodeURIComponent(name)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return `Error: ${(body as { error?: string }).error ?? res.statusText}`;
      }
      const text = await res.text();
      // Trim very large files to a sensible limit
      const MAX = 8000;
      if (text.length > MAX) {
        return text.slice(0, MAX) + `\n\n... (truncated — full file is ${text.length} chars)`;
      }
      return text;
    } catch (err) {
      return `Error fetching example conf: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
