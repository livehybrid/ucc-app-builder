/**
 * "Seed from installed app" - load an add-on already installed on THIS Splunk into the
 * builder, so the AI can extend it (add inputs, props/transforms, dashboards, tests…)
 * without a manual export. Native Splunk app only (uses the loader's same-origin REST
 * helper); the backend reads the add-on's source (globalConfig.json + package/default +
 * package/bin), excluding vendored libs, bytecode and secrets.
 */
import { analyzeImportedFiles } from './importer';
import type { ImportAnalysis } from '../types/manifest';

type SplunkFetch = (path: string, init?: RequestInit) => Promise<Response>;

function splunkFetch(): SplunkFetch | undefined {
  return (window as unknown as { __UCC_SPLUNK_FETCH__?: SplunkFetch }).__UCC_SPLUNK_FETCH__;
}

/** True when the seed-from-installed REST surface is reachable (native Splunk app only). */
export function installedAppsAvailable(): boolean {
  return !!splunkFetch();
}

export interface InstalledApp {
  appId: string;
  displayName: string;
  version: string;
  isUCCApp: boolean;
}

async function call(path: string, body: unknown): Promise<Record<string, unknown>> {
  const fn = splunkFetch();
  if (!fn) throw new Error('Seed from installed app requires the native Splunk app.');
  const res = await fn(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.error) throw new Error(String(data.error || `HTTP ${res.status}`));
  return data;
}

/** List add-ons installed on this Splunk that can be seeded (UCC add-ons first). */
export async function listInstalledApps(): Promise<InstalledApp[]> {
  const d = await call('/list_installed_apps', {});
  return Array.isArray(d.apps) ? (d.apps as InstalledApp[]) : [];
}

/**
 * Read an installed add-on's source and analyze it into an ImportAnalysis ready for
 * loadImportToVFS - the same shape the ZIP import produces.
 */
export async function importInstalledApp(appId: string): Promise<ImportAnalysis> {
  const d = await call('/import_installed_app', { appId });
  const files = Array.isArray(d.files)
    ? (d.files as Array<{ path: string; content: string }>)
    : [];
  if (files.length === 0) throw new Error('That app exposed no importable source files.');
  return analyzeImportedFiles(files);
}
