/**
 * "My Apps" — server-side (KV) library of saved add-on projects, so a user can save,
 * list, resume and delete multiple add-ons across sessions/devices. Available only in the
 * native Splunk app (uses the same-origin splunkd REST endpoints via the loader's helper);
 * standalone keeps its single-state localStorage.
 */

type SplunkFetch = (path: string, init?: RequestInit) => Promise<Response>;

function splunkFetch(): SplunkFetch | undefined {
  return (window as unknown as { __UCC_SPLUNK_FETCH__?: SplunkFetch }).__UCC_SPLUNK_FETCH__;
}

export function appLibraryAvailable(): boolean {
  return !!splunkFetch();
}

async function call(path: string, body: unknown): Promise<Record<string, unknown>> {
  const fn = splunkFetch();
  if (!fn) throw new Error('My Apps requires the native Splunk app.');
  const res = await fn(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.error) throw new Error(String(data.error || `HTTP ${res.status}`));
  return data;
}

export interface SavedApp {
  appId: string;
  name: string;
  version: string;
  updated_at: number;
  fileCount: number;
}

export interface LoadedApp {
  appId: string;
  name: string;
  version: string;
  files: Array<{ path: string; content: string }>;
}

export async function listApps(): Promise<SavedApp[]> {
  const d = await call('/list_apps', {});
  return Array.isArray(d.apps) ? (d.apps as SavedApp[]) : [];
}

export async function saveApp(
  appId: string,
  name: string,
  version: string,
  files: Array<{ path: string; content: string }>
): Promise<{ fileCount: number }> {
  const d = await call('/save_app', { appId, name, version, files });
  return { fileCount: Number(d.fileCount ?? files.length) };
}

export async function loadApp(appId: string): Promise<LoadedApp | null> {
  const d = await call('/load_app', { appId });
  if (d.found === false) return null;
  return {
    appId: String(d.appId ?? appId),
    name: String(d.name ?? appId),
    version: String(d.version ?? '1.0.0'),
    files: Array.isArray(d.files) ? (d.files as LoadedApp['files']) : [],
  };
}

export async function deleteApp(appId: string): Promise<void> {
  await call('/delete_app', { appId });
}
