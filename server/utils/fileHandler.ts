import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createReadStream } from 'fs';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

export class FileHandler {
  private tempBaseDir: string;

  constructor() {
    this.tempBaseDir = path.join(os.tmpdir(), 'ucc-app-builder');
  }

  /**
   * Create a temporary directory for a build
   */
  async createTempDirectory(buildId: string): Promise<string> {
    const dir = path.join(this.tempBaseDir, buildId);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, 'package'), { recursive: true });
    return dir;
  }

  /**
   * Write files from the VFS to the filesystem
   */
  async writeFiles(
    baseDir: string,
    files: Array<{ path: string; content: string }>
  ): Promise<void> {
    for (const file of files) {
      // Normalize the path and remove leading slashes
      let filePath = file.path.replace(/^\/+/, '');

      // If path starts with appId/package, restructure for ucc-gen
      const parts = filePath.split('/');
      if (parts.length > 1 && parts[1] === 'package') {
        // Remove the appId prefix, keep package/...
        filePath = parts.slice(1).join('/');
      } else if (filePath.endsWith('app.manifest') && !filePath.includes('package/')) {
        // Ensure app.manifest is in the package directory
        filePath = `package/${path.basename(filePath)}`;
      }

      const fullPath = path.join(baseDir, filePath);

      // SECURITY (defense in depth): never write outside the build's temp dir.
      // Callers (the MCP core) already reject ".." at the write_file boundary, but
      // guard here too so any path that resolves outside baseDir is skipped rather
      // than escaping the sandbox onto the host filesystem.
      const baseResolved = path.resolve(baseDir);
      if (
        path.resolve(fullPath) !== baseResolved &&
        !path.resolve(fullPath).startsWith(baseResolved + path.sep)
      ) {
        throw new Error(`Refusing to write outside the build directory: ${file.path}`);
      }

      const dir = path.dirname(fullPath);

      // Create directory if needed
      await fs.mkdir(dir, { recursive: true });

      // Write file content
      // Check if content is base64 (for binary files)
      if (this.isBase64(file.content) && this.isBinaryExtension(filePath)) {
        await fs.writeFile(fullPath, Buffer.from(file.content, 'base64'));
      } else {
        await fs.writeFile(fullPath, file.content, 'utf-8');
      }

      // ucc-gen build expects globalConfig.json in the workDir root (cwd), not under appId/
      const pathSegments = file.path.replace(/^\/+/, '').split('/');
      if (
        pathSegments.length === 2 &&
        pathSegments[1] === 'globalConfig.json' &&
        pathSegments[0].length > 0
      ) {
        const workDirGlobalConfigPath = path.join(baseDir, 'globalConfig.json');
        if (this.isBase64(file.content) && this.isBinaryExtension('globalConfig.json')) {
          await fs.writeFile(workDirGlobalConfigPath, Buffer.from(file.content, 'base64'));
        } else {
          await fs.writeFile(workDirGlobalConfigPath, file.content, 'utf-8');
        }
      }
    }
  }

  /**
   * Read all files from a directory recursively
   */
  async readDirectory(dir: string): Promise<Array<{ path: string; content: string }>> {
    const files: Array<{ path: string; content: string }> = [];

    async function walk(currentDir: string, basePath: string) {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relativePath = path.join(basePath, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath, relativePath);
        } else {
          const content = await fs.readFile(fullPath, 'utf-8');
          files.push({ path: relativePath, content });
        }
      }
    }

    await walk(dir, '');
    return files;
  }

  /**
   * Create a ZIP/tarball from a directory
   */
  async createZipFromDirectory(dir: string): Promise<Buffer> {
    // For simplicity, we'll create a simple tarball
    // In production, use a proper tar library
    const files = await this.readDirectory(dir);

    // Return as JSON for now - the frontend can handle packaging
    // In production, use archiver or tar-stream
    return Buffer.from(JSON.stringify(files));
  }

  /**
   * Clean up a build directory
   */
  async cleanup(buildId: string): Promise<void> {
    const dir = path.join(this.tempBaseDir, buildId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(`Failed to cleanup ${buildId}:`, error);
    }
  }

  /**
   * Clean up old builds (older than 1 hour)
   */
  async cleanupOldBuilds(): Promise<void> {
    try {
      const entries = await fs.readdir(this.tempBaseDir, { withFileTypes: true });
      const oneHourAgo = Date.now() - 60 * 60 * 1000;

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(this.tempBaseDir, entry.name);
          const stats = await fs.stat(dirPath);

          if (stats.mtimeMs < oneHourAgo) {
            await fs.rm(dirPath, { recursive: true, force: true });
          }
        }
      }
    } catch (error) {
      // Directory might not exist yet
    }
  }

  /**
   * Check if a string looks like base64
   */
  private isBase64(str: string): boolean {
    if (str.length < 100) return false;
    return /^[A-Za-z0-9+/]+=*$/.test(str.substring(0, 100));
  }

  /**
   * Check if file extension indicates binary
   */
  private isBinaryExtension(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot'].includes(ext);
  }
}
