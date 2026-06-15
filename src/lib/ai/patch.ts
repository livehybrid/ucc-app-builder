/**
 * Aider-inspired unified-diff patch applicator.
 *
 * The LLM emits patches in a simple textual format:
 *
 *     *** Begin Patch
 *     *** Update File: package/bin/foo.py
 *     @@
 *      def existing_line():
 *     -    old_body
 *     +    new_body
 *     *** End Patch
 *
 * We match the `-` and context lines fuzzily (whitespace-insensitive) against
 * the current file, then produce the new contents. If a hunk cannot be
 * matched, we reject it with enough detail for the agent to retry.
 *
 * Rationale: full-file rewrites are the single biggest source of regression in
 * coding agents (see docs/research/03-tool-design-patterns.md). `apply_patch`
 * forces the model to cite surrounding context, which is cheaper, safer, and
 * more easily auditable.
 */

export interface PatchHunk {
  /** Lines that must match in the file (as-is or with `-` / ` ` prefix stripped). */
  contextAndMinus: string[];
  /** Lines that will appear in the new file (context + added). */
  contextAndPlus: string[];
}

export interface PatchFileOp {
  kind: 'update' | 'create' | 'delete';
  path: string;
  hunks: PatchHunk[];
  /** For `create`: the full new file content (there are no hunks). */
  createContent?: string;
}

export interface ParsedPatch {
  files: PatchFileOp[];
}

export class PatchParseError extends Error {}
export class PatchApplyError extends Error {}

/**
 * Parse the patch envelope into structured file operations.
 */
export function parsePatch(text: string): ParsedPatch {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  const beginIdx = lines.findIndex((l) => l.trim() === '*** Begin Patch');
  const endIdx = lines.findIndex((l) => l.trim() === '*** End Patch');
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    throw new PatchParseError(
      'Invalid patch: must be wrapped in "*** Begin Patch" / "*** End Patch".'
    );
  }

  const body = lines.slice(beginIdx + 1, endIdx);
  const files: PatchFileOp[] = [];

  let i = 0;
  while (i < body.length) {
    const line = body[i];
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const { hunks, nextIndex } = parseHunks(body, i + 1);
      if (hunks.length === 0) {
        throw new PatchParseError(`No hunks found for Update File: ${path}`);
      }
      files.push({ kind: 'update', path, hunks });
      i = nextIndex;
    } else if (line.startsWith('*** Create File: ')) {
      const path = line.slice('*** Create File: '.length).trim();
      const contentLines: string[] = [];
      let j = i + 1;
      while (j < body.length && !body[j].startsWith('*** ')) {
        // Content lines in create blocks are prefixed with `+` to mirror unified diff.
        const raw = body[j];
        if (raw.startsWith('+')) contentLines.push(raw.slice(1));
        else if (raw === '') contentLines.push('');
        else contentLines.push(raw);
        j++;
      }
      files.push({
        kind: 'create',
        path,
        hunks: [],
        createContent: contentLines.join('\n'),
      });
      i = j;
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      files.push({ kind: 'delete', path, hunks: [] });
      i++;
    } else if (line.trim() === '' || line.startsWith('*** ')) {
      i++;
    } else {
      // Stray content at the top-level is a parse error — but be forgiving to
      // whitespace-only lines above.
      if (line.trim() === '') {
        i++;
      } else {
        throw new PatchParseError(`Unexpected patch directive: ${line}`);
      }
    }
  }

  if (files.length === 0) {
    throw new PatchParseError('Patch contains no file operations.');
  }
  return { files };
}

function parseHunks(body: string[], start: number): { hunks: PatchHunk[]; nextIndex: number } {
  const hunks: PatchHunk[] = [];
  let i = start;
  while (i < body.length) {
    const line = body[i];
    if (line.startsWith('*** ')) break;
    if (line.startsWith('@@')) {
      // New hunk header — ignore the rest of the header line.
      const hunk: PatchHunk = { contextAndMinus: [], contextAndPlus: [] };
      i++;
      while (i < body.length && !body[i].startsWith('@@') && !body[i].startsWith('*** ')) {
        const raw = body[i];
        if (raw.startsWith('+')) {
          hunk.contextAndPlus.push(raw.slice(1));
        } else if (raw.startsWith('-')) {
          hunk.contextAndMinus.push(raw.slice(1));
        } else if (raw.startsWith(' ')) {
          hunk.contextAndMinus.push(raw.slice(1));
          hunk.contextAndPlus.push(raw.slice(1));
        } else if (raw === '') {
          // Blank context line.
          hunk.contextAndMinus.push('');
          hunk.contextAndPlus.push('');
        } else {
          // Unexpected prefix — treat as context to be lenient.
          hunk.contextAndMinus.push(raw);
          hunk.contextAndPlus.push(raw);
        }
        i++;
      }
      hunks.push(hunk);
    } else {
      i++;
    }
  }
  return { hunks, nextIndex: i };
}

/**
 * Apply a parsed patch to a provided set of existing files.
 *
 * `readFile` returns `null` for files that don't exist.
 * We return the list of write / delete operations so callers can commit them to
 * their storage (e.g. the VFS or a real fs).
 */
export interface PatchOutcome {
  writes: { path: string; content: string }[];
  deletes: string[];
  summary: string[];
}

export function applyPatch(
  patch: ParsedPatch,
  readFile: (path: string) => string | null
): PatchOutcome {
  const writes: { path: string; content: string }[] = [];
  const deletes: string[] = [];
  const summary: string[] = [];

  for (const file of patch.files) {
    if (file.kind === 'create') {
      if (readFile(file.path) !== null) {
        throw new PatchApplyError(
          `Cannot create ${file.path}: file already exists. Use "Update File" instead.`
        );
      }
      writes.push({ path: file.path, content: file.createContent ?? '' });
      summary.push(`create ${file.path}`);
      continue;
    }

    if (file.kind === 'delete') {
      if (readFile(file.path) === null) {
        throw new PatchApplyError(`Cannot delete ${file.path}: file does not exist.`);
      }
      deletes.push(file.path);
      summary.push(`delete ${file.path}`);
      continue;
    }

    // Update
    const current = readFile(file.path);
    if (current === null) {
      throw new PatchApplyError(
        `Cannot update ${file.path}: file does not exist. Use "Create File" instead.`
      );
    }
    const updated = applyHunksToContent(current, file.hunks, file.path);
    writes.push({ path: file.path, content: updated });
    summary.push(`update ${file.path} (${file.hunks.length} hunk(s))`);
  }

  return { writes, deletes, summary };
}

function applyHunksToContent(content: string, hunks: PatchHunk[], path: string): string {
  // Work line-by-line; preserve the original trailing-newline state.
  const hadTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  // Strip the empty string left by trailing-newline so `lines` represents the
  // file's real lines only.
  if (hadTrailingNewline) lines.pop();

  for (let idx = 0; idx < hunks.length; idx++) {
    const hunk = hunks[idx];
    const matchAt = findHunkMatch(lines, hunk.contextAndMinus);
    if (matchAt === -1) {
      throw new PatchApplyError(
        `Could not match hunk ${idx + 1} in ${path}. ` +
          `Context (${hunk.contextAndMinus.length} lines) did not match the file. ` +
          `Re-read the file and regenerate the patch with exact context.`
      );
    }
    lines.splice(matchAt, hunk.contextAndMinus.length, ...hunk.contextAndPlus);
  }

  const joined = lines.join('\n');
  return hadTrailingNewline ? joined + '\n' : joined;
}

/**
 * Find the first index `i` such that `lines.slice(i, i + needle.length)` matches
 * `needle`. Matching is done in three increasingly permissive passes:
 *   1. Exact
 *   2. Whitespace-normalised (trim + collapse internal whitespace)
 *   3. Trim-only
 * Returns -1 when no match is found.
 */
export function findHunkMatch(lines: string[], needle: string[]): number {
  if (needle.length === 0) return 0;

  // Pass 1: exact.
  outer: for (let i = 0; i + needle.length <= lines.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (lines[i + j] !== needle[j]) continue outer;
    }
    return i;
  }

  // Pass 2: whitespace-normalised.
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const normNeedle = needle.map(norm);
  outer2: for (let i = 0; i + needle.length <= lines.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (norm(lines[i + j]) !== normNeedle[j]) continue outer2;
    }
    return i;
  }

  // Pass 3: trim-only.
  const trim = (s: string) => s.replace(/\s+$/g, '').replace(/^\s+/g, '');
  const trimNeedle = needle.map(trim);
  outer3: for (let i = 0; i + needle.length <= lines.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (trim(lines[i + j]) !== trimNeedle[j]) continue outer3;
    }
    return i;
  }

  return -1;
}
