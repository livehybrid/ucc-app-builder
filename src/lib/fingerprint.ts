/**
 * UCC-gen fingerprinting for import analysis.
 *
 * Sends the imported app's globalConfig.json to the server, which runs ucc-gen
 * in a temp dir and returns sha256 checksums of every generated output file.
 * We then reclassify imported files by comparing their checksums:
 *
 *   checksum matches fingerprint  → 'generated'         (untouched ucc-gen output)
 *   checksum differs              → 'modified-generated' (user changed it)
 *   not in fingerprints           → keep current origin  (ucc-gen doesn't produce it)
 */

import type { ImportAnalysis, FileOrigin } from '../types/manifest';

interface FingerprintResponse {
  available: boolean;
  fingerprints: Record<string, string>;
  error?: string;
}

export async function fingerprintWithUCCGen(
  analysis: ImportAnalysis,
): Promise<{ analysis: ImportAnalysis; available: boolean; error?: string }> {
  if (!analysis.globalConfig) {
    return { analysis, available: false };
  }

  let data: FingerprintResponse;
  try {
    const res = await fetch('/api/import/fingerprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ globalConfig: analysis.globalConfig, appId: analysis.appId }),
    });
    if (!res.ok) return { analysis, available: false };
    data = await res.json() as FingerprintResponse;
  } catch {
    return { analysis, available: false };
  }

  if (!data.available) {
    return { analysis, available: false };
  }

  const { fingerprints } = data;
  if (Object.keys(fingerprints).length === 0) {
    return { analysis, available: true, error: data.error };
  }

  const reclassified = analysis.files.map((file) => {
    const expectedChecksum = fingerprints[file.path];
    if (expectedChecksum === undefined) {
      // ucc-gen doesn't produce this file — keep existing classification
      return file;
    }
    const origin: FileOrigin =
      file.checksum === expectedChecksum
        ? 'generated'        // byte-for-byte match: ucc-gen would produce exactly this
        : 'modified-generated'; // ucc-gen generates it but user has changed it
    return { ...file, origin };
  });

  return { analysis: { ...analysis, files: reclassified }, available: true, error: data.error };
}
