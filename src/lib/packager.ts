/**
 * ZIP packaging for Splunk apps
 * Uses JSZip to create downloadable app archives
 */

import JSZip from 'jszip';
import { VirtualFileSystem } from './vfs';

/**
 * Create a ZIP archive from the VFS contents
 */
export async function createAppZip(vfs: VirtualFileSystem): Promise<Blob> {
  const zip = new JSZip();
  const files = vfs.listAllFiles();

  for (const file of files) {
    // Remove leading slash for zip paths
    const zipPath = file.path.replace(/^\//, '');
    zip.file(zipPath, file.content);
  }

  return zip.generateAsync({ type: 'blob' });
}

/**
 * Trigger a browser download for the ZIP
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Generate and download app as ZIP
 */
export async function downloadAppAsZip(vfs: VirtualFileSystem, appName: string): Promise<void> {
  const blob = await createAppZip(vfs);
  const filename = `${appName.toLowerCase().replace(/[^a-z0-9]/g, '_')}.zip`;
  downloadBlob(blob, filename);
}
