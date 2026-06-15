import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { stripIncompatibleBinaries } from './uccGen';

/** Build a minimal ELF header with the given e_machine (offset 18, LE). */
function elf(machine: number): Buffer {
  const buf = Buffer.alloc(64);
  buf[0] = 0x7f;
  buf[1] = 0x45; // E
  buf[2] = 0x4c; // L
  buf[3] = 0x46; // F
  buf[4] = 2; // EI_CLASS = 64-bit
  buf[5] = 1; // EI_DATA = little-endian
  buf.writeUInt16LE(machine, 18); // e_machine
  return buf;
}

const EM_X86_64 = 0x3e;
const EM_AARCH64 = 0xb7;

describe('stripIncompatibleBinaries', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'strip-test-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('removes x86-64 .so, Windows .pyd/.dll and macOS .dylib, keeps aarch64 .so and pure Python', async () => {
    const libs = path.join(dir, 'lib', 'mypkg');
    await fs.mkdir(libs, { recursive: true });
    await fs.writeFile(path.join(libs, 'fast_x86.so'), elf(EM_X86_64));
    await fs.writeFile(path.join(libs, 'fast_arm.so'), elf(EM_AARCH64));
    await fs.writeFile(path.join(libs, 'ext.cpython-310-x86_64-linux-gnu.so'), elf(EM_X86_64));
    await fs.writeFile(path.join(libs, 'win.pyd'), Buffer.from('MZ...'));
    await fs.writeFile(path.join(libs, 'win.dll'), Buffer.from('MZ...'));
    await fs.writeFile(path.join(libs, 'mac.dylib'), Buffer.from('\xca\xfe\xba\xbe'));
    await fs.writeFile(path.join(libs, '__init__.py'), 'x = 1\n');
    await fs.writeFile(path.join(libs, 'module.py'), 'def f(): pass\n');

    const removed = await stripIncompatibleBinaries(dir);

    const removedNames = removed.map((p) => path.basename(p)).sort();
    expect(removedNames).toEqual(
      [
        'ext.cpython-310-x86_64-linux-gnu.so',
        'fast_x86.so',
        'mac.dylib',
        'win.dll',
        'win.pyd',
      ].sort()
    );

    // aarch64 .so and pure-Python files survive.
    await expect(fs.access(path.join(libs, 'fast_arm.so'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(libs, '__init__.py'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(libs, 'module.py'))).resolves.toBeUndefined();
    // incompatible ones are gone.
    await expect(fs.access(path.join(libs, 'fast_x86.so'))).rejects.toThrow();
    await expect(fs.access(path.join(libs, 'win.pyd'))).rejects.toThrow();
  });

  it('handles versioned shared objects (libfoo.so.1.2) and unreadable .so', async () => {
    await fs.mkdir(path.join(dir, 'lib'), { recursive: true });
    await fs.writeFile(path.join(dir, 'lib', 'libfoo.so.1'), elf(EM_X86_64));
    await fs.writeFile(path.join(dir, 'lib', 'garbage.so'), Buffer.from('not an elf'));

    const removed = await stripIncompatibleBinaries(dir);
    expect(removed.map((p) => path.basename(p)).sort()).toEqual(['garbage.so', 'libfoo.so.1']);
  });

  it('returns nothing for a pure-Python tree', async () => {
    await fs.mkdir(path.join(dir, 'bin'), { recursive: true });
    await fs.writeFile(path.join(dir, 'bin', 'input.py'), '# pure python\n');
    await fs.writeFile(path.join(dir, 'app.manifest'), '{}');
    expect(await stripIncompatibleBinaries(dir)).toEqual([]);
  });
});
