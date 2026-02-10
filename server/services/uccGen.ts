import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';

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
   * Get ucc-gen version
   */
  async getVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
      // Try to run ucc-gen directly
      const proc = spawn(this.uccGenPath, ['--version'], {
        env: { ...process.env, PATH: process.env.PATH }
      });

      let output = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          // If failed, try to find it with 'which' (macOS/Linux) or 'where' (Windows)
          const cmd = process.platform === 'win32' ? 'where' : 'which';
          const whichProc = spawn(cmd, ['ucc-gen']);

          let pathOutput = '';
          whichProc.stdout.on('data', (d) => pathOutput += d.toString());

          whichProc.on('close', (whichCode) => {
             if (whichCode === 0) {
                // Found it, but maybe failed earlier? Return found path
                resolve(`Found at: ${pathOutput.trim()} (Exit code ${code} from version check)`);
             } else {
                reject(new Error(`ucc-gen not found in PATH (${process.env.PATH}). Output: ${output}`));
             }
          });
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to run ucc-gen: ${err.message}. PATH: ${process.env.PATH}`));
      });
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
