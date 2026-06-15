/**
 * Bundled Splunk Spec Files
 *
 * Loaded from the vendor/splunk-spec-files git submodule
 * (https://github.com/livehybrid/splunk-spec-files) which tracks official
 * Splunk .conf.spec files across Splunk Enterprise versions.
 *
 * Uses Vite's import.meta.glob with ?raw to eagerly bundle every
 * *.conf.spec file as a raw string at build time.
 */

// Eagerly import all .conf.spec files from the submodule as raw strings
const specModules = import.meta.glob<string>('/vendor/splunk-spec-files/*.conf.spec', {
  query: '?raw',
  eager: true,
  import: 'default',
});

/**
 * Map of conf filename (e.g. "props.conf") to spec file content.
 * The key is the .conf filename that users would create in their app.
 */
export const SPLUNK_SPECS: Record<string, string> = {};

for (const [path, content] of Object.entries(specModules)) {
  // path looks like "/vendor/splunk-spec-files/props.conf.spec"
  // We want the key to be "props.conf"
  const filename = path.split('/').pop(); // "props.conf.spec"
  if (filename) {
    const confName = filename.replace(/\.spec$/, ''); // "props.conf"
    SPLUNK_SPECS[confName] = content;
  }
}

/**
 * Get a list of all available conf file names that have spec definitions.
 */
export function getAvailableSpecs(): string[] {
  return Object.keys(SPLUNK_SPECS).sort();
}

/**
 * Check if a conf file has spec definitions available.
 */
export function hasSpec(confFilename: string): boolean {
  return confFilename in SPLUNK_SPECS;
}
