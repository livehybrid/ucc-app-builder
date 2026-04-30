import { Tool, validateWritePath } from '../tools';

export const createFile: Tool = {
  name: 'create_file',
  description:
    'Create a brand-new file. Fails if the file already exists — use apply_patch or write_file to modify existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path of the new file (must be within package/).',
      },
      content: {
        type: 'string',
        description: 'The full content of the new file.',
      },
    },
    required: ['path', 'content'],
  },
  execute: async (args, vfs) => {
    const path = args.path as string;
    const content = args.content as string;

    const pathError = validateWritePath(path);
    if (pathError) return pathError;

    if (vfs.readFile(path) !== null) {
      return `Error: ${path} already exists. Use apply_patch to edit it.`;
    }

    if (
      content.includes('BEGIN RSA PRIVATE KEY') ||
      content.includes('BEGIN PRIVATE KEY')
    ) {
      return 'Security Error: Writing raw private keys is not allowed.';
    }

    vfs.writeFile(path, content, 'user');
    return `Created ${path} (${content.length} bytes).`;
  },
};
