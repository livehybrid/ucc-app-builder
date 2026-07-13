/**
 * App Import functionality
 * Analyzes imported apps and classifies file origins
 */

import JSZip from 'jszip';
import { sha256 } from './crypto';
import type { FileOrigin, ImportAnalysis, ManifestFile, UCCBuildManifest } from '../types/manifest';
import { FILE_PATTERNS } from '../types/manifest';
import { VirtualFileSystem } from './vfs';

/**
 * Decompress a gzip+tar (.tgz / .spl / .tar.gz) file and return its entries.
 * Uses the native DecompressionStream API (available in all modern browsers).
 */
async function extractTarGz(file: File): Promise<Array<{ path: string; content: string }>> {
  // Step 1: gunzip
  const compressed = await file.arrayBuffer();
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(compressed);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const tarData = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) { tarData.set(c, offset); offset += c.length; }

  // Step 2: parse tar
  const entries: Array<{ path: string; content: string }> = [];
  const td = new TextDecoder();
  let pos = 0;

  while (pos + 512 <= tarData.length) {
    const header = tarData.slice(pos, pos + 512);
    // All-zero block = end of archive
    if (header.every((b) => b === 0)) break;

    const name = td.decode(header.slice(0, 100)).replace(/\0+$/, '');
    const prefix = td.decode(header.slice(345, 500)).replace(/\0+$/, '');
    const fullPath = prefix ? `${prefix}/${name}` : name;
    const sizeOctal = td.decode(header.slice(124, 136)).replace(/\0+$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);

    pos += 512; // advance past header

    if (typeflag === '0' || typeflag === '\0') {
      // Regular file
      const fileData = tarData.slice(pos, pos + size);
      const normalized = normalizePath(fullPath);
      if (normalized && !isBinaryFile(normalized)) {
        entries.push({ path: normalized, content: td.decode(fileData) });
      } else if (normalized) {
        // Base64-encode binary files
        let binary = '';
        for (let i = 0; i < fileData.length; i++) binary += String.fromCharCode(fileData[i]);
        entries.push({ path: normalized, content: btoa(binary) });
      }
    }

    // Advance past file data (padded to 512-byte boundary)
    pos += Math.ceil(size / 512) * 512;
  }

  return entries;
}

/**
 * Import an app from a .tgz / .spl / .tar.gz compiled Splunk package.
 */
/**
 * Shared analysis logic for both ZIP and tarball imports.
 * Handles globalConfig relocation from compiled appserver path,
 * author/email extraction from app.manifest, and file classification.
 */
async function analyzeFiles(
  rawFiles: Array<{ path: string; content: string; checksum: string }>,
  warnings: string[],
): Promise<ImportAnalysis> {
  const files = [...rawFiles];

  // Determine appId from the first path
  let appId = 'unknown_app';
  const firstPath = files[0]?.path;
  if (firstPath) {
    const match = firstPath.match(/^([^/]+)\//);
    if (match) appId = match[1];
  }

  // Relocate globalConfig from compiled appserver path if no source-level one exists
  const sourceGlobalConfig = files.find(
    (f) =>
      f.path === `${appId}/globalConfig.json` ||
      f.path === `${appId}/package/globalConfig.json`,
  );
  const compiledGlobalConfig = !sourceGlobalConfig
    ? files.find((f) => f.path.endsWith('/appserver/static/js/build/globalConfig.json'))
    : null;
  if (compiledGlobalConfig) {
    // Inject a source-level copy; the compiled copy stays and gets classified as generated
    files.push({ ...compiledGlobalConfig, path: `${appId}/globalConfig.json` });
    warnings.push('globalConfig.json relocated from appserver/static/js/build/ to app root.');
  }

  const effectiveGlobalConfig = sourceGlobalConfig ?? compiledGlobalConfig ?? null;

  let globalConfig: object | null = null;
  let displayName = 'Unknown App';
  let version = '1.0.0';

  if (effectiveGlobalConfig) {
    try {
      globalConfig = JSON.parse(effectiveGlobalConfig.content);
      const meta = (globalConfig as { meta?: { name?: string; displayName?: string; version?: string } }).meta;
      if (meta) {
        appId = meta.name || appId;
        displayName = meta.displayName || displayName;
        version = meta.version || version;
      }
    } catch {
      warnings.push('Could not parse globalConfig.json');
    }
  } else {
    const appConf = files.find(
      (f) => f.path === `${appId}/default/app.conf` || f.path.endsWith('/default/app.conf'),
    );
    if (appConf) {
      const labelMatch = appConf.content.match(/label\s*=\s*(.+)/);
      const versionMatch = appConf.content.match(/version\s*=\s*(.+)/);
      if (labelMatch) displayName = labelMatch[1].trim();
      if (versionMatch) version = versionMatch[1].trim();
    }
  }

  // Extract author/email from app.manifest if present
  let author: string | undefined;
  let email: string | undefined;
  const manifestFile = files.find(
    (f) => f.path === `${appId}/app.manifest` || f.path === `${appId}/package/app.manifest`,
  );
  if (manifestFile) {
    try {
      const manifest = JSON.parse(manifestFile.content) as {
        info?: { author?: Array<{ name?: string; email?: string }> };
      };
      const firstAuthor = manifest.info?.author?.[0];
      if (firstAuthor?.name) author = firstAuthor.name;
      if (firstAuthor?.email) email = firstAuthor.email;
    } catch {
      // app.manifest parse failure is non-fatal
    }
  }

  const classifiedFiles = files.map((f) => ({ ...f, origin: classifyFileOrigin(f.path, appId) }));
  return { appId, displayName, version, author, email, globalConfig, files: classifiedFiles, warnings, isUCCApp: globalConfig !== null };
}

async function importAppFromTarball(file: File): Promise<ImportAnalysis> {
  const warnings: string[] = [];
  let tarEntries: Array<{ path: string; content: string }>;
  try {
    tarEntries = await extractTarGz(file);
  } catch (err) {
    throw new Error(`Could not read tarball: ${err instanceof Error ? err.message : String(err)}`);
  }

  const files = await Promise.all(
    tarEntries.map(async (e) => ({ ...e, checksum: await sha256(e.content) })),
  );
  return analyzeFiles(files, warnings);
}

/**
 * Import an app from a ZIP file
 */
export async function importAppFromZip(zipFile: File): Promise<ImportAnalysis> {
  const isTarball = zipFile.name.endsWith('.tgz') || zipFile.name.endsWith('.spl') || zipFile.name.endsWith('.tar.gz');

  if (isTarball) {
    return importAppFromTarball(zipFile);
  }

  const zip = await JSZip.loadAsync(zipFile);
  const files: Array<{ path: string; content: string; checksum: string }> = [];
  const warnings: string[] = [];

  for (const [path, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;
    try {
      if (isBinaryFile(path)) {
        const base64 = await zipEntry.async('base64');
        const checksum = await sha256(base64);
        files.push({ path: normalizePath(path), content: base64, checksum });
      } else {
        const content = await zipEntry.async('string');
        const checksum = await sha256(content);
        files.push({ path: normalizePath(path), content, checksum });
      }
    } catch {
      warnings.push(`Could not read file: ${path}`);
    }
  }

  return analyzeFiles(files, warnings);
}

/**
 * Classify a file's origin based on its path
 */
export function classifyFileOrigin(filePath: string, appId: string): FileOrigin {
  const normalizedPath = normalizePath(filePath);

  // Check if it's globalConfig.json at root or package
  if (normalizedPath === `${appId}/globalConfig.json` || normalizedPath === `${appId}/package/globalConfig.json`) {
    return 'source';
  }

  // Check if it's a known source file
  for (const sourcePattern of FILE_PATTERNS.source) {
    if (normalizedPath.endsWith(sourcePattern) ||
        normalizedPath === `${appId}/${sourcePattern}`) {
      return 'source';
    }
  }

  // Check if it matches generated file patterns
  for (const pattern of FILE_PATTERNS.generated) {
    if (pattern.test(normalizedPath)) {
      return 'generated';
    }
  }

  // Check if it's in a source directory (package/)
  if (normalizedPath.includes('/package/')) {
    return 'source';
  }

  // Files in bin/ that aren't matched by generated patterns are custom
  if (normalizedPath.includes('/bin/')) {
    return 'custom';
  }

  // Default to custom for unrecognized files
  return 'custom';
}

/**
 * Load imported app into VFS
 */
export function loadImportToVFS(
  vfs: VirtualFileSystem,
  analysis: ImportAnalysis
): void {
  vfs.clear();

  for (const file of analysis.files) {
    vfs.writeFile(`/${file.path}`, file.content);
  }
}

/**
 * Create a build manifest from import analysis
 */
export function createManifestFromImport(analysis: ImportAnalysis): UCCBuildManifest {
  const now = new Date().toISOString();

  const manifestFiles: ManifestFile[] = analysis.files.map(file => ({
    path: file.path,
    origin: file.origin,
    checksum: file.checksum,
    generatedChecksum: file.origin === 'generated' ? file.checksum : undefined,
  }));

  return {
    version: '1.0.0',
    appId: analysis.appId,
    displayName: analysis.displayName,
    appVersion: analysis.version,
    createdAt: now,
    updatedAt: now,
    globalConfigPath: `${analysis.appId}/globalConfig.json`, // Default to root for new manifests
    files: manifestFiles,
    build: {
      builderVersion: '0.1.0',
    },
  };
}

/**
 * Extract source files for version control
 */
export function extractSourceFiles(
  analysis: ImportAnalysis
): Array<{ path: string; content: string; origin: FileOrigin }> {
  return analysis.files
    .filter(f => f.origin === 'source' || f.origin === 'custom' || f.origin === 'modified-generated')
    .map(f => ({
      path: f.path,
      content: f.content,
      origin: f.origin,
    }));
}

/**
 * Check if a file path is likely binary
 */
function isBinaryFile(path: string): boolean {
  const binaryExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.ico',
    '.woff', '.woff2', '.ttf', '.eot',
    '.zip', '.tar', '.gz', '.tgz',
    '.pyc', '.pyo',
  ];
  return binaryExtensions.some(ext => path.toLowerCase().endsWith(ext));
}

/**
 * Normalize file path (remove leading slashes, normalize separators)
 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}
