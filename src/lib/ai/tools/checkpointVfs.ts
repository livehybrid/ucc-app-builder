import { Tool } from '../tools';

export const checkpointVfs: Tool = {
  name: 'checkpoint_vfs',
  description:
    'Save a named snapshot of the current VFS state so it can be restored later. ' +
    'Call this BEFORE making a large batch of changes so the user can roll back if something goes wrong. ' +
    'Use a short descriptive name, e.g. "before_api_rewrite".',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Checkpoint name (alphanumeric + underscores), e.g. "before_api_rewrite".',
      },
    },
    required: ['name'],
  },
  execute: async (args, vfs) => {
    const name = String(args.name ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!name) return 'Error: name is required.';
    vfs.checkpoint(name);
    const fileCount = vfs.listAllFiles().length;
    return `Checkpoint "${name}" saved (${fileCount} files). Use restore_checkpoint to roll back.`;
  },
};

export const restoreCheckpoint: Tool = {
  name: 'restore_checkpoint',
  description:
    'Restore the VFS to a previously saved checkpoint, discarding all changes made since. ' +
    'Use list_checkpoints first to see available checkpoints.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the checkpoint to restore.',
      },
    },
    required: ['name'],
  },
  execute: async (args, vfs) => {
    const name = String(args.name ?? '').trim();
    if (!name) return 'Error: name is required.';
    const ok = vfs.restoreCheckpoint(name);
    if (!ok) {
      const available = vfs.listCheckpoints();
      return available.length > 0
        ? `Error: checkpoint "${name}" not found. Available: ${available.join(', ')}`
        : `Error: no checkpoints saved yet. Use checkpoint_vfs to save one first.`;
    }
    const fileCount = vfs.listAllFiles().length;
    return `Restored checkpoint "${name}" (${fileCount} files). All changes since that point have been reverted.`;
  },
};

export const listCheckpoints: Tool = {
  name: 'list_checkpoints',
  description: 'List all saved VFS checkpoints available for restore.',
  parameters: { type: 'object', properties: {} },
  execute: async (_args, vfs) => {
    const names = vfs.listCheckpoints();
    if (names.length === 0) return 'No checkpoints saved yet.';
    return `Saved checkpoints (${names.length}):\n${names.map((n) => `  - ${n}`).join('\n')}`;
  },
};
