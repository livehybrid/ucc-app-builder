/**
 * Cryptographic utilities for file checksums
 */

/**
 * Calculate SHA-256 hash of a string
 */
export async function sha256(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Calculate checksums for multiple files
 */
export async function calculateChecksums(
  files: Array<{ path: string; content: string }>
): Promise<Map<string, string>> {
  const checksums = new Map<string, string>();

  await Promise.all(
    files.map(async (file) => {
      const hash = await sha256(file.content);
      checksums.set(file.path, hash);
    })
  );

  return checksums;
}
