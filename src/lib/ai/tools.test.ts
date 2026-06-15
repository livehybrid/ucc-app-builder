import { describe, it, expect } from 'vitest';
import { validatePath, validateWritePath } from './tools';

describe('Path Validation', () => {
  describe('validatePath', () => {
    it('should allow safe paths', () => {
      expect(validatePath('package/bin/test.py')).toBeNull();
      expect(validatePath('README.md')).toBeNull();
    });

    it('should block absolute system paths', () => {
      expect(validatePath('/etc/passwd')).toContain('Security Error');
      expect(validatePath('/usr/bin/python')).toContain('Security Error');
    });

    it('should block parent directory traversal', () => {
      expect(validatePath('../secret.txt')).toContain('Security Error');
      expect(validatePath('package/../../etc')).toContain('Security Error');
    });

    it('should block hidden directories', () => {
      expect(validatePath('.git/config')).toContain('Security Error');
      expect(validatePath('.env')).toContain('Security Error');
    });
  });

  describe('validateWritePath', () => {
    it('should allow writing to package/ directory', () => {
      expect(validateWritePath('package/bin/test.py')).toBeNull();
      expect(validateWritePath('/package/default/app.conf')).toBeNull();
    });

    it('should block writing outside package/', () => {
      expect(validateWritePath('root_file.txt')).toContain('Security Error');
      expect(validateWritePath('src/components/Test.tsx')).toContain('Security Error');
    });

    it('should allow globalConfig.json at the project root (UCC requires it beside package/)', () => {
      expect(validateWritePath('globalConfig.json')).toBeNull();
      expect(validateWritePath('TA_demo/globalConfig.json')).toBeNull();
    });
  });
});

type StringArgResult = { ok: true; value: string } | { ok: false; error: string };
const asErr = (r: StringArgResult) => (r.ok ? undefined : r.error);
const asVal = (r: StringArgResult) => (r.ok ? r.value : undefined);

describe('requireStringArg (graceful missing-arg handling)', () => {
  it('returns a model-friendly error instead of crashing when path is missing', async () => {
    const { requireStringArg } = await import('./toolTypes');
    expect(asErr(requireStringArg({}, 'path', 'read_file'))).toMatch(
      /requires a non-empty string "path".*got: missing/
    );
    expect(asErr(requireStringArg({ path: 42 }, 'path', 'read_file'))).toMatch(/got: number/);
    expect(asVal(requireStringArg({ path: 'ok' }, 'path', 'read_file'))).toBe('ok');
  });

  it('allowEmpty permits empty strings (e.g. empty __init__.py content)', async () => {
    const { requireStringArg } = await import('./toolTypes');
    expect(
      asVal(requireStringArg({ content: '' }, 'content', 'write_file', { allowEmpty: true }))
    ).toBe('');
    expect(asErr(requireStringArg({ content: '' }, 'content', 'write_file'))).toBeTruthy();
  });

  it('file tools survive a missing path without throwing', async () => {
    const { readFile } = await import('./tools/readFile');
    const { writeFile } = await import('./tools/writeFile');
    const { createFile } = await import('./tools/createFile');
    const { VirtualFileSystem } = await import('../vfs');
    const vfs = new VirtualFileSystem();
    await expect(readFile.execute({}, vfs)).resolves.toMatch(/requires a non-empty string "path"/);
    await expect(writeFile.execute({ content: 'x' }, vfs)).resolves.toMatch(
      /requires a non-empty string "path"/
    );
    await expect(createFile.execute({ content: 'x' }, vfs)).resolves.toMatch(
      /requires a non-empty string "path"/
    );
  });
});

describe('read_file near-match suggestions', () => {
  it('suggests the app-id-prefixed path when the model uses a bare filename', async () => {
    const { readFile } = await import('./tools/readFile');
    const { VirtualFileSystem } = await import('../vfs');
    const vfs = new VirtualFileSystem();
    vfs.writeFile('mynewapp/globalConfig.json', '{}', 'user');
    const result = await readFile.execute({ path: 'globalConfig.json' }, vfs);
    expect(result).toContain('Did you mean');
    expect(result).toContain('mynewapp/globalConfig.json');
  });
});
