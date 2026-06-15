import { Tool } from '../toolTypes';

export const listFiles: Tool = {
  name: 'list_files',
  description: 'List all files in the project to understand structure.',
  parameters: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'Optional directory to list (e.g., "package/bin")',
      },
    },
  },
  execute: async (args, vfs) => {
    const dir = (args.directory as string) || '';
    const files = vfs
      .listAllFiles()
      .map((f) => f.path)
      .filter((p) => p.startsWith(dir));

    // Cap results to prevent token overflow
    if (files.length > 500) {
      return JSON.stringify(
        {
          warning: `Too many files (${files.length}), showing first 500`,
          files: files.slice(0, 500),
        },
        null,
        2
      );
    }

    return JSON.stringify(files, null, 2);
  },
};
