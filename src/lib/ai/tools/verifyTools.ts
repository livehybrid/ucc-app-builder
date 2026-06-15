/**
 * Agent-callable tools that close the build → inspect → install → browser-check
 * loop. They delegate all privileged work (spawning processes, Docker, file-
 * system access) to the server under `/api/agent/*`.
 *
 * Rationale (see docs/research/00-synthesis.md §8): the user requires the
 * agent be able to self-verify any app it produces. Having these as first-class
 * tools lets the agent iterate without a human-in-the-loop for every build.
 */

import { Tool } from '../toolTypes';

const AGENT_SESSION_KEY = 'ucc-agent-session-id';

function getSessionId(): string {
  // SSR-safe fallback.
  if (typeof window === 'undefined') return 'default';
  let id = window.localStorage.getItem(AGENT_SESSION_KEY);
  if (!id) {
    id = `sess_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
    window.localStorage.setItem(AGENT_SESSION_KEY, id);
  }
  return id;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}

async function fetchCapabilities(): Promise<{
  dockerToolsEnabled: boolean;
  browserCheckEnabled: boolean;
}> {
  try {
    const res = await fetch('/api/ai/config');
    if (!res.ok) return { dockerToolsEnabled: false, browserCheckEnabled: false };
    const json = await res.json();
    return {
      dockerToolsEnabled: Boolean(json?.capabilities?.dockerToolsEnabled),
      browserCheckEnabled: Boolean(json?.capabilities?.browserCheckEnabled),
    };
  } catch {
    return { dockerToolsEnabled: false, browserCheckEnabled: false };
  }
}

export const runUccGen: Tool = {
  name: 'run_ucc_gen',
  description:
    'Run `ucc-gen build` + `ucc-gen package` on the current VFS. Returns the tarball path and build logs. ' +
    'Call this after editing files to produce a deployable add-on artifact. The tarball is remembered for the rest of the session.',
  parameters: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'App id (directory name under package/).' },
      version: { type: 'string', description: 'Add-on version. Defaults to 1.0.0.' },
    },
    required: ['appId'],
  },
  execute: async (args, vfs) => {
    const appId = String(args.appId);
    const version = args.version ? String(args.version) : '1.0.0';
    const files = vfs.getAllFiles();
    const result = await postJson<{
      ok: boolean;
      tarball?: string;
      logs?: string[];
      error?: string;
    }>('/api/agent/ucc-gen', {
      sessionId: getSessionId(),
      files,
      appId,
      version,
    });
    if (!result.ok)
      return `ucc-gen failed: ${result.error}\n${(result.logs ?? []).slice(-20).join('\n')}`;
    return `Built ${appId}@${version} → ${result.tarball}\n${(result.logs ?? []).slice(-5).join('\n')}`;
  },
};

export const runAppInspect: Tool = {
  name: 'run_appinspect',
  description:
    'Run Splunk AppInspect against the most recent `run_ucc_gen` output. Requires `splunk-appinspect` CLI ' +
    'or APPINSPECT_TOKEN on the server. Returns a structured summary of failures and warnings.',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const result = await postJson<{
      ok: boolean;
      summary?: string;
      error?: string;
    }>('/api/agent/appinspect', { sessionId: getSessionId() });
    if (!result.ok) return `AppInspect failed: ${result.error}`;
    return result.summary ?? 'AppInspect completed (no summary available).';
  },
};

export const installToSplunkDocker: Tool = {
  name: 'install_to_splunk_docker',
  description:
    'Install the most recent build artifact into a local Splunk Docker container, restart Splunk, and return the web URL + any errors seen in splunkd.log. ' +
    'Requires Docker available on the server host. Safe to call repeatedly — the container is reused.',
  parameters: {
    type: 'object',
    properties: {
      webPort: { type: 'number', description: 'Host port for Splunk Web. Default 8000.' },
      mgmtPort: { type: 'number', description: 'Host port for management. Default 8089.' },
      containerName: {
        type: 'string',
        description: 'Container name. Default ucc-app-builder-splunk.',
      },
    },
  },
  execute: async (args) => {
    const caps = await fetchCapabilities();
    if (!caps.dockerToolsEnabled) {
      return 'install_to_splunk_docker is disabled for this deployment. Enable UCC_ENABLE_DOCKER_TOOLS=true in testing/self-hosted environments.';
    }
    const result = await postJson<{
      ok: boolean;
      webUrl?: string;
      errors?: string[];
      logs?: string[];
      error?: string;
    }>('/api/agent/install-docker', {
      sessionId: getSessionId(),
      webPort: args.webPort,
      mgmtPort: args.mgmtPort,
      containerName: args.containerName,
    });
    if (!result.ok && result.error)
      return `Install failed: ${result.error}\n${(result.logs ?? []).slice(-20).join('\n')}`;
    const errCount = result.errors?.length ?? 0;
    const head = errCount ? `Installed with ${errCount} splunkd.log errors.` : `Installed cleanly.`;
    const errLines = errCount ? '\n' + result.errors!.slice(0, 10).join('\n') : '';
    return `${head}\nSplunk Web: ${result.webUrl ?? '(unknown)'}${errLines}`;
  },
};

export const browserCheck: Tool = {
  name: 'browser_check',
  description:
    'Open a URL in headless Chromium and verify (a) no JS console errors, (b) no HTTP 5xx responses, (c) all expected texts appear in the body. ' +
    'Use after `install_to_splunk_docker` to verify the add-on setup page renders.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to open.' },
      expectTexts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Text snippets that must appear on the page.',
      },
    },
    required: ['url'],
  },
  execute: async (args) => {
    const caps = await fetchCapabilities();
    if (!caps.browserCheckEnabled) {
      return 'browser_check is disabled for this deployment. Enable UCC_ENABLE_BROWSER_CHECK=true where Playwright checks are allowed.';
    }
    const result = await postJson<{
      ok: boolean;
      stdout?: string;
      stderr?: string;
      error?: string;
    }>('/api/agent/browser-check', {
      sessionId: getSessionId(),
      url: args.url,
      expectTexts: args.expectTexts ?? [],
    });
    if (result.error) return `browser_check errored: ${result.error}`;
    const summary = result.stdout ?? '';
    return `${result.ok ? 'PASS' : 'FAIL'} ${args.url}\n${summary}${result.stderr ? '\n' + result.stderr : ''}`;
  },
};
