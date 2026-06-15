import { Tool, validateWritePath, requireStringArg } from '../toolTypes';

export const createFile: Tool = {
  name: 'create_file',
  description:
    'Create a brand-new file. Fails if the file already exists — use apply_patch or write_file to modify existing files. Paths start with the app id (match list_files output).',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'The path of the new file, starting with the app id — under "<appId>/package/", except globalConfig.json which must go at the project root ("<appId>/globalConfig.json", beside package/, never inside it).',
      },
      content: {
        type: 'string',
        description: 'The full content of the new file.',
      },
    },
    required: ['path', 'content'],
  },
  execute: async (args, vfs) => {
    const pathArg = requireStringArg(args, 'path', 'create_file');
    if (!pathArg.ok) return pathArg.error;
    const path = pathArg.value;
    const contentArg = requireStringArg(args, 'content', 'create_file', { allowEmpty: true });
    if (!contentArg.ok) return contentArg.error;
    const content = contentArg.value;

    const pathError = validateWritePath(path);
    if (pathError) return pathError;

    if (vfs.readFile(path) !== null) {
      return `Error: ${path} already exists. Use apply_patch to edit it.`;
    }

    if (content.includes('BEGIN RSA PRIVATE KEY') || content.includes('BEGIN PRIVATE KEY')) {
      return 'Security Error: Writing raw private keys is not allowed.';
    }

    vfs.writeFile(path, content, 'user');
    return `Created ${path} (${content.length} bytes).`;
  },
};
