import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';

/** ELF e_machine value for AArch64 (ARM64). */
const EM_AARCH64 = 0xb7;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // 0x7F 'E' 'L' 'F'

/**
 * Read an ELF file's `e_machine` (target architecture). Returns null if the file
 * isn't ELF (e.g. a pure-Python file, or a Windows .pyd / macOS .dylib).
 */
async function elfMachine(file: string): Promise<number | null> {
  let fh: import('fs/promises').FileHandle | undefined;
  try {
    fh = await fs.open(file, 'r');
    const buf = Buffer.alloc(20);
    const { bytesRead } = await fh.read(buf, 0, 20, 0);
    if (bytesRead < 20 || !buf.subarray(0, 4).equals(ELF_MAGIC)) return null;
    // EI_DATA at offset 5: 1 = little-endian, 2 = big-endian. e_machine at offset 18.
    return buf[5] === 2 ? buf.readUInt16BE(18) : buf.readUInt16LE(18);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/**
 * Remove bundled native binaries from a built add-on that are NOT aarch64-compatible,
 * so the package passes AppInspect `check_aarch64_compatibility`.
 *
 * Why: `ucc-gen build` pip-installs `package/lib/requirements.txt` into the output
 * `lib/`. On an x86_64 build host, compiled extensions (`.so` from protobuf/grpc,
 * or mypyc-compiled wheels) are x86_64 — which fails the aarch64 check. The pure
 * Python sources ship alongside, so removing the compiled `.so` leaves a working,
 * architecture-neutral package. Building on an aarch64 host leaves its (compatible)
 * binaries in place. Non-Linux artifacts (`.pyd`/`.dylib`) are always removed —
 * they don't belong in a Splunk (Linux) add-on.
 *
 * Returns the app-relative paths removed.
 */
export async function stripIncompatibleBinaries(appRoot: string): Promise<string[]> {
  const removed: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      const isSharedObject = /\.so(\.\d+)*$/.test(lower);
      const isWindows = lower.endsWith('.pyd') || lower.endsWith('.dll');
      const isMac = lower.endsWith('.dylib');
      if (!isSharedObject && !isWindows && !isMac) continue;

      // .pyd/.dll/.dylib never belong in a Linux Splunk add-on → always drop.
      // .so → drop unless it is an aarch64 ELF (i.e. already compatible).
      let drop = isWindows || isMac;
      if (isSharedObject) {
        const machine = await elfMachine(full);
        drop = machine !== EM_AARCH64; // x86-64, 32-bit ARM, unreadable, etc.
      }
      if (drop) {
        try {
          await fs.rm(full);
          removed.push(path.relative(appRoot, full));
        } catch {
          /* ignore */
        }
      }
    }
  }

  await walk(appRoot);
  return removed;
}

export interface BuildStatus {
  id: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  progress: number;
  logs: string[];
  error?: string;
  outputPath?: string;
  appId?: string;
  startedAt: string;
  completedAt?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export class UCCGenService {
  private uccGenPath: string;

  constructor() {
    // Use ucc-gen from PATH or specify custom path
    this.uccGenPath = process.env.UCC_GEN_PATH || 'ucc-gen';
  }

  /**
   * Get ucc-gen version.
   *
   * `ucc-gen --version` is NOT a valid flag in ucc 6.x (it errors with exit 2),
   * so we read the version straight from the installed Python package instead,
   * which is the source of truth.
   */
  async getVersion(): Promise<string> {
    const fromPython = await new Promise<string | null>((resolve) => {
      const proc = spawn('python3', [
        '-c',
        'import splunk_add_on_ucc_framework as u; print(getattr(u, "__version__", ""))',
      ]);
      let out = '';
      proc.stdout.on('data', (d) => (out += d.toString()));
      proc.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
      proc.on('error', () => resolve(null));
    });

    if (fromPython) return fromPython;

    // Fallback: confirm the CLI at least exists on PATH.
    return new Promise((resolve, reject) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const whichProc = spawn(cmd, ['ucc-gen']);
      let pathOutput = '';
      whichProc.stdout.on('data', (d) => (pathOutput += d.toString()));
      whichProc.on('close', (whichCode) => {
        if (whichCode === 0) resolve(`available at ${pathOutput.trim()}`);
        else reject(new Error(`ucc-gen not found in PATH (${process.env.PATH}).`));
      });
      whichProc.on('error', (err) =>
        reject(new Error(`Failed to locate ucc-gen: ${err.message}.`)),
      );
    });
  }

  /**
   * Initialize a UCC project
   */
  async init(
    workDir: string,
    appId: string,
    onLog: (log: string) => void
  ): Promise<void> {
    // Check if package directory exists with globalConfig.json
    const packageDir = path.join(workDir, 'package');
    const globalConfigPath = path.join(packageDir, 'globalConfig.json');
    const rootGlobalConfigPath = path.join(workDir, 'globalConfig.json');

    try {
      // Check package/globalConfig.json first
      await fs.access(globalConfigPath);
      onLog('Found existing globalConfig.json, skipping init');
      return;
    } catch {
      try {
        // Check root globalConfig.json
        await fs.access(rootGlobalConfigPath);
        onLog('Found existing globalConfig.json, skipping init');
        return;
      } catch {
        // Need to initialize
      }
    }

    return new Promise((resolve, reject) => {
      // Newer versions of ucc-gen require these specific arguments
      const args = [
        'init',
        '--addon-name', appId,
        '--addon-display-name', appId,
        '--addon-input-name', appId,
        '--overwrite'
      ];
      onLog(`Running: ${this.uccGenPath} ${args.join(' ')}`);

      const proc = spawn(this.uccGenPath, args, {
        cwd: workDir,
        env: { ...process.env },
      });

      proc.stdout.on('data', (data) => {
        onLog(data.toString().trim());
      });

      proc.stderr.on('data', (data) => {
        onLog(`[stderr] ${data.toString().trim()}`);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ucc-gen init failed with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to run ucc-gen init: ${err.message}`));
      });
    });
  }

  /**
   * Build the UCC app
   */
  async build(
    workDir: string,
    onLog: (log: string) => void,
    version?: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const outputDir = path.join(workDir, 'output');
      const args = ['build', '--source', path.join(workDir, 'package'), '--output', outputDir];

      if (version) {
        args.push('--ta-version', version);
      }

      onLog(`Running: ${this.uccGenPath} ${args.join(' ')}`);

      const proc = spawn(this.uccGenPath, args, {
        cwd: workDir,
        env: { ...process.env },
      });

      proc.stdout.on('data', (data) => {
        onLog(data.toString().trim());
      });

      proc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        // UCC-gen outputs progress to stderr
        onLog(msg);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(outputDir);
        } else {
          reject(new Error(`ucc-gen build failed with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to run ucc-gen build: ${err.message}`));
      });
    });
  }

  /**
   * Validate globalConfig.json
   */
  async validateConfig(globalConfig: object): Promise<ValidationResult> {
    // Basic validation - in production, use JSON schema
    const errors: string[] = [];
    const warnings: string[] = [];

    const config = globalConfig as Record<string, unknown>;

    if (!config.meta) {
      errors.push('Missing required field: meta');
    } else {
      const meta = config.meta as Record<string, unknown>;
      if (!meta.name) errors.push('Missing required field: meta.name');
      if (!meta.restRoot) errors.push('Missing required field: meta.restRoot');
      if (!meta.version) errors.push('Missing required field: meta.version');
      if (!meta.displayName) errors.push('Missing required field: meta.displayName');
    }

    if (!config.pages) {
      warnings.push('No pages defined - app will have no UI');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Package the built app into a tarball
   */
  async package(
    workDir: string,
    outputDir: string,
    onLog: (log: string) => void
  ): Promise<string> {
    // Strip non-aarch64 native binaries before packaging so the tarball passes
    // AppInspect check_aarch64_compatibility (the .so files are pip-installed into
    // the built lib/ and aren't in the source VFS, so this must happen here).
    try {
      const stripped = await stripIncompatibleBinaries(outputDir);
      if (stripped.length) {
        onLog(
          `Stripped ${stripped.length} non-aarch64 native binarie(s) for AppInspect compatibility: ` +
            stripped.slice(0, 10).join(', ') +
            (stripped.length > 10 ? ` (+${stripped.length - 10} more)` : '')
        );
      }
    } catch (e) {
      onLog(`Binary strip skipped: ${(e as Error).message}`);
    }

    return new Promise((resolve, reject) => {
      const args = ['package', '--path', outputDir];

      onLog(`Running: ${this.uccGenPath} ${args.join(' ')}`);

      const proc = spawn(this.uccGenPath, args, {
        cwd: workDir,
        env: { ...process.env },
      });

      let outputPath = '';

      const capturePath = (line: string) => {
        // ucc-gen prints "Package exported to /path/to/app-1.0.0.tar.gz" (often on stderr)
        const exportedMatch = line.match(/exported to\s+(.+?\.(?:tar\.gz|tgz))/i);
        if (exportedMatch) {
          outputPath = exportedMatch[1].trim();
          return;
        }
        // Fallback: line is exactly an absolute path to the tarball
        const trimmed = line.trim();
        if ((trimmed.endsWith('.tar.gz') || trimmed.endsWith('.tgz')) && path.isAbsolute(trimmed)) {
          outputPath = trimmed;
        }
      };

      proc.stdout.on('data', (data) => {
        const line = data.toString().trim();
        onLog(line);
        capturePath(line);
      });

      proc.stderr.on('data', (data) => {
        const line = data.toString().trim();
        onLog(line);
        capturePath(line);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(outputPath || path.join(workDir, 'package.tgz'));
        } else {
          reject(new Error(`ucc-gen package failed with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to run ucc-gen package: ${err.message}`));
      });
    });
  }
}
