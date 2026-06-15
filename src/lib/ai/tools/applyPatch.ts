import { Tool, validateWritePath, validatePath, requireStringArg } from '../toolTypes';
import {
  applyPatch as applyParsedPatch,
  parsePatch,
  PatchApplyError,
  PatchParseError,
} from '../patch';

export const applyPatch: Tool = {
  name: 'apply_patch',
  description:
    'Apply a unified-diff style patch to one or more files. Prefer this over write_file for any edit to an existing file. ' +
    'Format:\n' +
    '*** Begin Patch\n' +
    '*** Update File: <path>\n' +
    '@@\n' +
    ' <context line>\n' +
    '-<line to remove>\n' +
    '+<line to add>\n' +
    '*** Create File: <path>\n' +
    '+<new content line>\n' +
    '*** Delete File: <path>\n' +
    '*** End Patch\n\n' +
    'Include 2-5 lines of unchanged context around each change so the hunk can be located.',
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description:
          'The full patch envelope, starting with "*** Begin Patch" and ending with "*** End Patch".',
      },
    },
    required: ['patch'],
  },
  execute: async (args, vfs) => {
    const patchArg = requireStringArg(args, 'patch', 'apply_patch');
    if (!patchArg.ok) return patchArg.error;
    const patchText = patchArg.value;
    let parsed;
    try {
      parsed = parsePatch(patchText);
    } catch (e) {
      const msg = e instanceof PatchParseError ? e.message : String(e);
      return `Patch parse error: ${msg}`;
    }

    // Security check every touched path before we apply anything.
    for (const f of parsed.files) {
      const err = f.kind === 'delete' ? validatePath(f.path) : validateWritePath(f.path);
      if (err) return err;
    }

    let outcome;
    try {
      outcome = applyParsedPatch(parsed, (p) => vfs.readFile(p));
    } catch (e) {
      const msg = e instanceof PatchApplyError ? e.message : String(e);
      return `Patch apply error: ${msg}`;
    }

    for (const w of outcome.writes) {
      vfs.writeFile(w.path, w.content, 'user');
    }
    for (const d of outcome.deletes) {
      vfs.delete(d);
    }

    return `Patch applied: ${outcome.summary.join('; ')}`;
  },
};
