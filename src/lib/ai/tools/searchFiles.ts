import { Tool } from '../tools';

export const searchFiles: Tool = {
  name: 'search_files',
  description:
    'Search file contents across the VFS using a regex or plain-text pattern. ' +
    'Returns each matching file with line numbers and matching line content. ' +
    'Use this instead of read_file when you need to locate a symbol, function name, or string across multiple files.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex pattern (or plain string) to search for in file contents.',
      },
      path_filter: {
        type: 'string',
        description: 'Optional path substring filter, e.g. "package/bin" to restrict results.',
      },
      case_sensitive: {
        type: 'boolean',
        description: 'Whether the search is case-sensitive. Default true.',
      },
    },
    required: ['pattern'],
  },
  execute: async (args, vfs) => {
    const rawPattern = String(args.pattern ?? '');
    if (!rawPattern) return 'Error: pattern is required.';

    const pathFilter = String(args.path_filter ?? '');
    const flags = args.case_sensitive === false ? 'gim' : 'gm';

    let regex: RegExp;
    try {
      regex = new RegExp(rawPattern, flags);
    } catch {
      return `Error: invalid regex pattern "${rawPattern}".`;
    }

    const results: Array<{ path: string; matches: Array<{ line: number; content: string }> }> = [];
    const MAX_MATCHES_PER_FILE = 20;
    const MAX_FILES = 30;

    for (const file of vfs.listAllFiles()) {
      if (pathFilter && !file.path.includes(pathFilter)) continue;
      const content = vfs.readFile(file.path);
      if (!content) continue;

      const lines = content.split('\n');
      const matches: Array<{ line: number; content: string }> = [];

      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          matches.push({ line: i + 1, content: lines[i].trimEnd() });
          if (matches.length >= MAX_MATCHES_PER_FILE) break;
        }
      }

      if (matches.length > 0) {
        results.push({ path: file.path, matches });
        if (results.length >= MAX_FILES) break;
      }
    }

    if (results.length === 0) {
      return `No matches found for pattern: ${rawPattern}${pathFilter ? ` in paths containing "${pathFilter}"` : ''}`;
    }

    const total = results.reduce((s, r) => s + r.matches.length, 0);
    const summary = `Found ${total} match${total !== 1 ? 'es' : ''} in ${results.length} file${results.length !== 1 ? 's' : ''}:\n\n`;
    const body = results
      .map((r) =>
        `${r.path}:\n` +
        r.matches.map((m) => `  L${m.line}: ${m.content}`).join('\n'),
      )
      .join('\n\n');

    return summary + body;
  },
};
