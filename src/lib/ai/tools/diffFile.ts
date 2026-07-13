import { Tool } from '../tools';

/**
 * Minimal LCS-based unified diff.
 * Produces output compatible with standard unified-diff format.
 */
function lcsLength(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  // Use rolling two-row DP to keep memory manageable for large files
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev.fill(0)];
  }
  // Rebuild full table for backtracking (only if file is small enough)
  const MAX = 500;
  if (m > MAX || n > MAX) return []; // signal too large
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

type DiffEntry = { type: 'equal' | 'insert' | 'delete'; line: string };

function computeDiff(a: string[], b: string[]): DiffEntry[] {
  const MAX = 500;
  if (a.length > MAX || b.length > MAX) {
    return [{ type: 'insert', line: `(files too large for inline diff — ${a.length}→${b.length} lines)` }];
  }
  const dp = lcsLength(a, b);
  if (dp.length === 0) return [];

  const result: DiffEntry[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ type: 'equal', line: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'insert', line: b[j - 1] });
      j--;
    } else {
      result.unshift({ type: 'delete', line: a[i - 1] });
      i--;
    }
  }
  return result;
}

function formatUnifiedDiff(diffs: DiffEntry[], label: string, contextLines = 3): string {
  if (diffs.length === 0) return `--- ${label}\n+++ ${label}\n(no differences)`;

  // Find changed indices
  const changed = new Set<number>();
  diffs.forEach((d, i) => { if (d.type !== 'equal') changed.add(i); });
  if (changed.size === 0) return `--- ${label}\n+++ ${label}\n(files are identical)`;

  // Build context windows
  const inContext = new Set<number>();
  changed.forEach((i) => {
    for (let k = Math.max(0, i - contextLines); k <= Math.min(diffs.length - 1, i + contextLines); k++) {
      inContext.add(k);
    }
  });

  const lines: string[] = [`--- ${label} (current)`, `+++ ${label} (proposed)`];
  let oldLine = 1;
  let newLine = 1;
  let chunkStart = -1;
  let chunk: string[] = [];

  const flushChunk = () => {
    if (chunk.length === 0) return;
    lines.push(`@@ -${oldLine} +${newLine} @@`);
    lines.push(...chunk);
    chunk = [];
    chunkStart = -1;
  };

  let prevInCtx = false;
  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i];
    const inCtx = inContext.has(i);

    if (!inCtx && prevInCtx) flushChunk();

    if (inCtx) {
      if (chunkStart === -1) {
        // Record line numbers at chunk start
        chunkStart = i;
      }
      if (d.type === 'equal') { chunk.push(` ${d.line}`); oldLine++; newLine++; }
      else if (d.type === 'delete') { chunk.push(`-${d.line}`); oldLine++; }
      else { chunk.push(`+${d.line}`); newLine++; }
    } else {
      if (d.type === 'equal') { oldLine++; newLine++; }
      else if (d.type === 'delete') { oldLine++; }
      else { newLine++; }
    }
    prevInCtx = inCtx;
  }
  flushChunk();

  return lines.join('\n');
}

export const diffFile: Tool = {
  name: 'diff_file',
  description:
    'Show a unified diff between the current VFS content of a file and proposed new content. ' +
    'Call this BEFORE write_file to preview what will change. ' +
    'Returns a standard unified-diff output with ±3 lines of context around each change.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path in the VFS, e.g. "package/bin/my_input_helper.py".',
      },
      proposed_content: {
        type: 'string',
        description: 'The new content you intend to write.',
      },
    },
    required: ['path', 'proposed_content'],
  },
  execute: async (args, vfs) => {
    const path = String(args.path ?? '').trim();
    const proposed = String(args.proposed_content ?? '');

    if (!path) return 'Error: path is required.';

    const current = vfs.readFile(path) ?? '';
    if (current === proposed) return `${path}: no changes (files are identical).`;

    const aLines = current.split('\n');
    const bLines = proposed.split('\n');
    const diffs = computeDiff(aLines, bLines);
    return formatUnifiedDiff(diffs, path);
  },
};
