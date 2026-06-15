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
 * Generate a pytest-splunk-addon test scaffold (props/transforms/CIM validation) for the
 * add-on's sourcetypes and write it into the project under tests/. The validation half of
 * the data loop: pair it with the input emulator (capture real events → paste as
 * sampleEvents). Also exposed as the `ucc_generate_tests` Splunk MCP tool.
 */
export const generateTests: Tool = {
  name: 'generate_tests',
  description:
    'Generate a pytest-splunk-addon test scaffold to validate the add-on (sourcetype/source/' +
    'index assignment, props/transforms field extractions, CIM compliance). Args: sourcetypes:' +
    '[{sourcetype, source?, index?, inputType?, cimDataModels?, sampleEvents?}]. Paste real ' +
    'events from the input emulator as sampleEvents. Writes tests/. Use after authoring props.',
  parameters: {
    type: 'object',
    properties: {
      sourcetypes: {
        type: 'array',
        description: 'Sourcetypes to validate.',
        items: {
          type: 'object',
          properties: {
            sourcetype: { type: 'string' },
            source: { type: 'string' },
            index: { type: 'string' },
            inputType: { type: 'string' },
            cimDataModels: { type: 'array', items: { type: 'string' } },
            sampleEvents: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    required: ['sourcetypes'],
  },
  execute: async (args, vfs) => {
    try {
      const res = await fetch(`${API_BASE}/generate/tests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...args, addonName: appIdOf(vfs) }),
      });
      const d = (await res.json()) as {
        ok?: boolean;
        files?: Array<{ path: string; content: string }>;
        error?: string;
      };
      if (!d.ok || !d.files) return `Error: ${d.error || 'test scaffold generation failed'}`;
      const root = appIdOf(vfs);
      for (const f of d.files) vfs.writeFile(`${root}/${f.path}`, f.content, 'user');
      return `Generated pytest-splunk-addon scaffold (${d.files.length} files) under ${root}/tests/. Run it against a Splunk to validate props/transforms/CIM.`;
    } catch (e) {
      return `Error generating tests: ${(e as Error).message}`;
    }
  },
};
