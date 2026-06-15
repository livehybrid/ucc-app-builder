/**
 * Source Export functionality
 * Exports only source files for version control / CI/CD
 */

import JSZip from 'jszip';
import type { UCCBuildManifest, UCCProjectFile } from '../types/manifest';
import type { ImportAnalysis } from '../types/manifest';
import { VirtualFileSystem } from './vfs';

/**
 * Create a .uccproject file from import analysis
 */
export function createProjectFile(
  analysis: ImportAnalysis,
  branding: { navBarColor: string; logoPath?: string } = { navBarColor: '#65A637' }
): UCCProjectFile {
  return {
    version: '1.0.0',
    metadata: {
      name: analysis.appId,
      displayName: analysis.displayName,
      description: '',
      author: '',
      version: analysis.version,
      appId: analysis.appId,
    },
    branding,
    globalConfig: analysis.globalConfig || {},
    customFiles: analysis.files.filter((f) => f.origin === 'custom').map((f) => f.path),
  };
}

/**
 * Export source files as a ZIP for version control
 */
export async function exportSourceAsZip(
  analysis: ImportAnalysis,
  manifest: UCCBuildManifest
): Promise<Blob> {
  const zip = new JSZip();

  // Add project file
  const projectFile = createProjectFile(analysis);
  zip.file(`${analysis.appId}.uccproject`, JSON.stringify(projectFile, null, 2));

  // Add manifest
  zip.file('.uccbuild/manifest.json', JSON.stringify(manifest, null, 2));

  // Add source and custom files only
  for (const file of analysis.files) {
    if (
      file.origin === 'source' ||
      file.origin === 'custom' ||
      file.origin === 'modified-generated'
    ) {
      // Restructure into package/ directory format
      const sourcePath = convertToSourcePath(file.path, analysis.appId);
      zip.file(sourcePath, file.content);
    }
  }

  return zip.generateAsync({ type: 'blob' });
}

/**
 * Convert a full app path to a source path (package/ structure)
 */
export function convertToSourcePath(filePath: string, appId: string): string {
  // Normalize leading slash
  let path = filePath.startsWith('/') ? filePath.slice(1) : filePath;

  // Remove app ID prefix if present (e.g. "myapp/package/..." -> "package/...")
  if (path.startsWith(`${appId}/`)) {
    path = path.slice(appId.length + 1);
  }

  // globalConfig.json should strictly be at the root
  if (path === 'globalConfig.json') {
    return path;
  }

  // If not already in package/, add it
  if (!path.startsWith('package/')) {
    path = `package/${path}`;
  }

  return path;
}

/**
 * Extract App ID from globalConfig.json in VFS
 */
export function getAppIdFromVFS(vfs: VirtualFileSystem, fallback: string): string {
  const files = vfs.listAllFiles();
  const globalConfigFile = files.find((f) => f.name === 'globalConfig.json');

  if (globalConfigFile) {
    try {
      const globalConfig = JSON.parse(globalConfigFile.content);
      if (globalConfig?.meta?.name) {
        return globalConfig.meta.name;
      }
    } catch (e) {
      console.warn('Failed to parse globalConfig.json', e);
    }
  }
  return fallback;
}

/**
 * Generate a summary of what will be exported vs regenerated
 */
export function generateExportSummary(analysis: ImportAnalysis): {
  source: string[];
  custom: string[];
  generated: string[];
  modifiedGenerated: string[];
} {
  const summary = {
    source: [] as string[],
    custom: [] as string[],
    generated: [] as string[],
    modifiedGenerated: [] as string[],
  };

  for (const file of analysis.files) {
    switch (file.origin) {
      case 'source':
        summary.source.push(file.path);
        break;
      case 'custom':
        summary.custom.push(file.path);
        break;
      case 'generated':
        summary.generated.push(file.path);
        break;
      case 'modified-generated':
        summary.modifiedGenerated.push(file.path);
        break;
    }
  }

  return summary;
}

/**
 * Create package/ directory structure from VFS for ucc-gen
 */
export function createPackageStructure(vfs: VirtualFileSystem, appId: string): VirtualFileSystem {
  const packageVfs = new VirtualFileSystem();
  const files = vfs.listAllFiles();

  for (const file of files) {
    // Convert to package/ structure
    let targetPath = file.path;

    // Remove app prefix if present
    if (targetPath.startsWith(`/${appId}/`)) {
      targetPath = targetPath.slice(appId.length + 1);
    }

    // Ensure in package/ directory
    if (!targetPath.startsWith('/package/')) {
      targetPath = `/package${targetPath}`;
    }

    packageVfs.writeFile(targetPath, file.content);
  }

  return packageVfs;
}

/**
 * Create ImportAnalysis from VFS state
 */
function createAnalysisFromVFS(vfs: VirtualFileSystem, fallbackAppId: string): ImportAnalysis {
  const files = vfs.listAllFiles();
  const globalConfigFile = files.find((f) => f.name === 'globalConfig.json');
  let globalConfig = null;
  const appId = getAppIdFromVFS(vfs, fallbackAppId);

  if (globalConfigFile) {
    try {
      globalConfig = JSON.parse(globalConfigFile.content);
    } catch (e) {
      console.warn('Failed to parse globalConfig.json', e);
    }
  }

  return {
    appId,
    displayName: appId, // Could extract from globalConfig
    version: '1.0.0', // Could extract
    globalConfig,
    files: files.map((f) => ({
      path: f.path,
      content: f.content,
      origin:
        f.source === 'generated'
          ? 'generated'
          : f.source === 'modified'
            ? 'modified-generated'
            : 'source',
      checksum: '', // Not used for export
    })),
    warnings: [],
    isUCCApp: true,
  };
}

/**
 * Export source files from VFS as ZIP
 */
export async function exportSourceZipFromVFS(vfs: VirtualFileSystem, appId: string): Promise<Blob> {
  const analysis = createAnalysisFromVFS(vfs, appId);
  // Create a dummy manifest for the build tracking
  const manifest: UCCBuildManifest = {
    version: '1.0.0',
    appId,
    displayName: appId,
    appVersion: '1.0.0',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    globalConfigPath: 'globalConfig.json',
    files: [],
    build: { builderVersion: '1.0.0' },
  };
  return exportSourceAsZip(analysis, manifest);
}
