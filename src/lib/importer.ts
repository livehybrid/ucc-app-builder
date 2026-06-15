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
 * Import an app from a ZIP file
 */
export async function importAppFromZip(zipFile: File): Promise<ImportAnalysis> {
  const zip = await JSZip.loadAsync(zipFile);
  const files: Array<{ path: string; content: string; checksum: string }> = [];
  const warnings: string[] = [];

  // Extract all files (text as string, binary as base64)
  for (const [path, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;

    try {
      if (isBinaryFile(path)) {
        // Read binary files as base64
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

  // Find globalConfig.json (relaxed search first to get metadata)
  const globalConfigFile = files.find((f) => f.path.endsWith('globalConfig.json'));

  let globalConfig: object | null = null;
  let appId = 'unknown_app';
  let displayName = 'Unknown App';
  let version = '1.0.0';

  if (globalConfigFile) {
    try {
      globalConfig = JSON.parse(globalConfigFile.content);
      const meta = (
        globalConfig as { meta?: { name?: string; displayName?: string; version?: string } }
      ).meta;
      if (meta) {
        appId = meta.name || appId;
        displayName = meta.displayName || displayName;
        version = meta.version || version;
      }
    } catch {
      warnings.push('Could not parse globalConfig.json');
    }
  } else {
    // Try to extract from app.conf
    const appConf = files.find((f) => f.path.endsWith('/default/app.conf'));
    if (appConf) {
      const labelMatch = appConf.content.match(/label\s*=\s*(.+)/);
      const versionMatch = appConf.content.match(/version\s*=\s*(.+)/);
      if (labelMatch) displayName = labelMatch[1].trim();
      if (versionMatch) version = versionMatch[1].trim();
    }

    // Extract appId from path
    const firstPath = files[0]?.path;
    if (firstPath) {
      const match = firstPath.match(/^([^/]+)\//);
      if (match) appId = match[1];
    }
  }

  // Classify each file
  const classifiedFiles = files.map((file) => ({
    ...file,
    origin: classifyFileOrigin(file.path, appId),
  }));

  return {
    appId,
    displayName,
    version,
    globalConfig,
    files: classifiedFiles,
    warnings,
    isUCCApp: globalConfig !== null,
  };
}

/**
 * Classify a file's origin based on its path
 */
export function classifyFileOrigin(filePath: string, appId: string): FileOrigin {
  const normalizedPath = normalizePath(filePath);

  // Check if it's globalConfig.json at root or package
  if (
    normalizedPath === `${appId}/globalConfig.json` ||
    normalizedPath === `${appId}/package/globalConfig.json`
  ) {
    return 'source';
  }

  // Check if it's a known source file
  for (const sourcePattern of FILE_PATTERNS.source) {
    if (normalizedPath.endsWith(sourcePattern) || normalizedPath === `${appId}/${sourcePattern}`) {
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
export function loadImportToVFS(vfs: VirtualFileSystem, analysis: ImportAnalysis): void {
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

  const manifestFiles: ManifestFile[] = analysis.files.map((file) => ({
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
    .filter(
      (f) => f.origin === 'source' || f.origin === 'custom' || f.origin === 'modified-generated'
    )
    .map((f) => ({
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
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.zip',
    '.tar',
    '.gz',
    '.tgz',
    '.pyc',
    '.pyo',
  ];
  return binaryExtensions.some((ext) => path.toLowerCase().endsWith(ext));
}

/**
 * Normalize file path (remove leading slashes, normalize separators)
 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}
