import { describe, it, expect } from 'vitest';
import { applyPatch, findHunkMatch, parsePatch, PatchApplyError, PatchParseError } from './patch';

const makeReader = (files: Record<string, string>) => (p: string) => (p in files ? files[p] : null);

describe('parsePatch', () => {
  it('parses a simple update hunk', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: package/bin/foo.py',
      '@@',
      ' def hello():',
      '-    return 1',
      '+    return 2',
      '*** End Patch',
    ].join('\n');
    const parsed = parsePatch(text);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      kind: 'update',
      path: 'package/bin/foo.py',
    });
    expect(parsed.files[0].hunks[0].contextAndMinus).toEqual(['def hello():', '    return 1']);
    expect(parsed.files[0].hunks[0].contextAndPlus).toEqual(['def hello():', '    return 2']);
  });

  it('parses a create file op', () => {
    const text = [
      '*** Begin Patch',
      '*** Create File: package/README.md',
      '+# New file',
      '+body line',
      '*** End Patch',
    ].join('\n');
    const parsed = parsePatch(text);
    expect(parsed.files[0].kind).toBe('create');
    expect(parsed.files[0].createContent).toBe('# New file\nbody line');
  });

  it('parses a delete file op', () => {
    const text = ['*** Begin Patch', '*** Delete File: package/old.py', '*** End Patch'].join('\n');
    const parsed = parsePatch(text);
    expect(parsed.files[0]).toEqual({
      kind: 'delete',
      path: 'package/old.py',
      hunks: [],
    });
  });

  it('rejects missing envelope', () => {
    expect(() => parsePatch('no envelope here')).toThrow(PatchParseError);
  });

  it('rejects update with no hunks', () => {
    const text = ['*** Begin Patch', '*** Update File: package/foo.py', '*** End Patch'].join('\n');
    expect(() => parsePatch(text)).toThrow(PatchParseError);
  });
});

describe('findHunkMatch', () => {
  it('finds exact match', () => {
    const lines = ['a', 'b', 'c', 'd'];
    expect(findHunkMatch(lines, ['b', 'c'])).toBe(1);
  });

  it('finds whitespace-normalised match', () => {
    const lines = ['def  foo():', '    return   1'];
    expect(findHunkMatch(lines, ['def foo():', '    return 1'])).toBe(0);
  });

  it('returns -1 when no match', () => {
    expect(findHunkMatch(['a'], ['x', 'y'])).toBe(-1);
  });
});

describe('applyPatch', () => {
  it('applies a simple update', () => {
    const read = makeReader({
      'package/bin/foo.py': 'def hello():\n    return 1\n',
    });
    const patch = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: package/bin/foo.py',
        '@@',
        ' def hello():',
        '-    return 1',
        '+    return 2',
        '*** End Patch',
      ].join('\n')
    );
    const out = applyPatch(patch, read);
    expect(out.writes).toHaveLength(1);
    expect(out.writes[0].content).toBe('def hello():\n    return 2\n');
    expect(out.summary[0]).toMatch(/update package\/bin\/foo\.py/);
  });

  it('refuses to create over existing file', () => {
    const read = makeReader({ 'package/x.py': 'x' });
    const patch = parsePatch(
      ['*** Begin Patch', '*** Create File: package/x.py', '+new', '*** End Patch'].join('\n')
    );
    expect(() => applyPatch(patch, read)).toThrow(PatchApplyError);
  });

  it('refuses to update a missing file', () => {
    const read = makeReader({});
    const patch = parsePatch(
      ['*** Begin Patch', '*** Update File: missing.py', '@@', '-a', '+b', '*** End Patch'].join(
        '\n'
      )
    );
    expect(() => applyPatch(patch, read)).toThrow(PatchApplyError);
  });

  it('applies multiple hunks in order', () => {
    const read = makeReader({
      'f.py': 'line1\nline2\nline3\nline4\n',
    });
    const patch = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: f.py',
        '@@',
        '-line1',
        '+LINE1',
        '@@',
        '-line4',
        '+LINE4',
        '*** End Patch',
      ].join('\n')
    );
    const out = applyPatch(patch, read);
    expect(out.writes[0].content).toBe('LINE1\nline2\nline3\nLINE4\n');
  });

  it('reports helpful error when hunk does not match', () => {
    const read = makeReader({ 'f.py': 'totally different contents\n' });
    const patch = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: f.py',
        '@@',
        '-expected',
        '+replacement',
        '*** End Patch',
      ].join('\n')
    );
    expect(() => applyPatch(patch, read)).toThrow(/Could not match hunk/);
  });

  it('supports create then delete in one patch', () => {
    const read = makeReader({ 'old.py': 'old' });
    const patch = parsePatch(
      [
        '*** Begin Patch',
        '*** Create File: new.py',
        '+hello',
        '*** Delete File: old.py',
        '*** End Patch',
      ].join('\n')
    );
    const out = applyPatch(patch, read);
    expect(out.writes.map((w) => w.path)).toEqual(['new.py']);
    expect(out.deletes).toEqual(['old.py']);
  });

  it('preserves absence of trailing newline', () => {
    const read = makeReader({ 'f.py': 'a\nb' });
    const patch = parsePatch(
      ['*** Begin Patch', '*** Update File: f.py', '@@', '-b', '+B', '*** End Patch'].join('\n')
    );
    const out = applyPatch(patch, read);
    expect(out.writes[0].content).toBe('a\nB');
  });
});
