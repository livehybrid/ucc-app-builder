import { Tool, validateWritePath } from '../tools';

export const moveFile: Tool = {
  name: 'move_file',
  description:
    'Move or rename a file within the VFS. ' +
    'The destination must be inside package/ or be globalConfig.json. ' +
    'The source file is deleted after a successful copy.',
  parameters: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Current file path, e.g. "package/bin/old_name.py".',
      },
      destination: {
        type: 'string',
        description: 'New file path, e.g. "package/bin/new_name.py".',
      },
    },
    required: ['source', 'destination'],
  },
  execute: async (args, vfs) => {
    const src = String(args.source ?? '').trim();
    const dst = String(args.destination ?? '').trim();

    if (!src) return 'Error: source is required.';
    if (!dst) return 'Error: destination is required.';
    if (src === dst) return 'Error: source and destination are the same.';

    const dstErr = validateWritePath(dst);
    if (dstErr) return dstErr;

    const content = vfs.readFile(src);
    if (content === null) return `Error: source file not found: ${src}`;

    if (vfs.exists(dst)) {
      return `Error: destination already exists: ${dst}. Delete it first or choose a different name.`;
    }

    vfs.writeFile(dst, content, 'user');
    vfs.delete(src);

    return `Moved ${src} → ${dst}`;
  },
};
