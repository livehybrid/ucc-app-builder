import { Tool, validatePath, requireStringArg } from '../toolTypes';

export const readFile: Tool = {
  name: 'read_file',
  description:
    'Read the content of a specific file within the project. Use the EXACT paths returned by list_files — ' +
    'project files live under the app id (e.g. "my_app/globalConfig.json", "my_app/package/bin/input.py"). ' +
    'A leading slash is tolerated.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'The path of the file to read, exactly as shown by list_files (e.g. "<appId>/package/default/app.conf").',
      },
    },
    required: ['path'],
  },
  execute: async (args, vfs) => {
    const arg = requireStringArg(args, 'path', 'read_file');
    if (!arg.ok) return arg.error;
    const path = arg.value;

    // Security validation
    const pathError = validatePath(path);
    if (pathError) {
      return pathError;
    }

    const content = vfs.readFile(path);
    if (content === null) {
      // Suggest near-matches by basename so the model can self-correct a
      // missing "<appId>/" prefix instead of flailing on bare filenames.
      const basename = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
      const matches = basename
        ? vfs
            .listAllFiles()
            .map((f) => f.path)
            .filter((p) => p.split('/').pop() === basename)
            .slice(0, 5)
        : [];
      if (matches.length) {
        return `Error: File not found: ${path}. Did you mean: ${matches.join(', ')}? Use the exact paths returned by list_files (they start with the app id).`;
      }
      return `Error: File not found: ${path}. Use list_files to see the exact paths (they start with the app id, e.g. "<appId>/package/...").`;
    }

    // Truncate if too large to prevent overflow
    if (content.length > 20000) {
      return (
        `WARNING: File is too large (${content.length} chars). Showing first 20k chars:\n\n` +
        content.substring(0, 20000) +
        `\n\n... (truncated ${content.length - 20000} chars)`
      );
    }

    return content;
  },
};
