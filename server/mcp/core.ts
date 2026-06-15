/**
 * Shared MCP core for the UCC App Builder.
 *
 * One in-memory builder "session" (a VFS the agent/Assistant authors into) plus
 * the tool surface and dispatcher. Used by BOTH transports:
 *   - server/mcp/server.ts   — stdio MCP server (Claude Desktop, etc.)
 *   - server/routes/mcp.ts    — HTTP dispatch the Splunk MCP Server proxies to
 *     (API-execution tools registered in tools_payload_signatures), so the
 *     Splunk AI Assistant can build a UCC add-on via these tools.
 *
 * VFS-centric (not component-config) so the Assistant authors globalConfig.json /
 * package/bin/*.py directly via write_file — the same files the Monaco UI shows
 * and edits, and the same files the build loop consumes.
 */
import { VirtualFileSystem } from '../../src/lib/vfs.js';
import { runAgentLoop, LoopFile } from '../services/agentLoop.js';

export interface BuilderToolResult {
  text: string;
  /** Structured payload (files, findings, tarball, …) for programmatic callers. */
  data?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Confine a caller-supplied path to the project's own subtree.
 *
 * SECURITY: the AI agent / Splunk AI Assistant must never be able to escape the
 * add-on project — no reading or writing anything else on the host (this is a
 * hard requirement; a traversal hole would be a major hackathon security mark
 * against us). Returns the normalised `<appId>/<path>` on success, or `null` if
 * the path is absolute, contains a `..` segment, a NUL/backslash, or otherwise
 * resolves outside the project root. Reads/writes only ever hit the in-memory
 * VFS; this also guarantees the on-disk build materialisation stays in its temp
 * dir, since every path is already confined here.
 */
export function toSafeProjectPath(appId: string, p: string): string | null {
  if (typeof p !== 'string' || p.length === 0) return null;
  // Reject NUL bytes and backslashes (Windows-style traversal / smuggling).
  if (p.includes('\0') || p.includes('\\')) return null;
  // Reject absolute paths outright (predictable + airtight; no silent coercion).
  if (p.startsWith('/')) return null;
  const clean = p;
  const segments = clean.split('/');
  // Any '.' or '..' segment, or an empty segment (e.g. "a//b"), is rejected.
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  const rel = appId && !clean.startsWith(`${appId}/`) ? `${appId}/${clean}` : clean;
  // Final guard: the resolved path must stay under "<appId>/".
  if (appId && !rel.startsWith(`${appId}/`)) return null;
  return rel;
}

/** A single in-memory add-on project: appId/version + the authored files. */
export class BuilderSession {
  private vfs = new VirtualFileSystem();
  appId = '';
  version = '1.0.0';
  createdAt = Date.now();

  reset(appId: string, version = '1.0.0') {
    this.vfs = new VirtualFileSystem();
    this.appId = appId;
    this.version = version;
    this.createdAt = Date.now();
  }

  /** Confined path or throw — the build-loop backstop (callers validate first). */
  private safe(p: string): string {
    const s = toSafeProjectPath(this.appId, p);
    if (s === null) throw new Error(`Unsafe path rejected: ${p}`);
    return s;
  }

  /** True if a caller path is safe to write/read (no traversal, in-subtree). */
  isSafePath(p: string): boolean {
    return toSafeProjectPath(this.appId, p) !== null;
  }

  writeFile(path: string, content: string) {
    this.vfs.writeFile(this.safe(path), content, 'user');
  }

  readFile(path: string): string | null {
    return this.vfs.readFile(this.safe(path));
  }

  files(): LoopFile[] {
    return this.vfs.getAllFiles().map((f) => ({ path: f.path, content: f.content }));
  }

  /** Apply files the build loop wrote back (auto-fixes) into the session. */
  syncBack(files: LoopFile[]) {
    for (const f of files) this.vfs.writeFile(f.path.replace(/^\/+/, ''), f.content, 'generated');
  }
}

/** Derive a TA_-prefixed appId from a free-text name (mirrors the stdio server). */
export function deriveAppId(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return id.startsWith('ta_') ? id : `ta_${id}`;
}

/** The MCP tool surface. API-execution tools on the Splunk side map 1:1 to these. */
export const BUILDER_TOOLS = [
  {
    name: 'ucc_ping',
    description:
      'Health check for the UCC App Builder service. Returns { ok, appId, files } when reachable. Call first when troubleshooting connectivity.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ucc_create_addon',
    description:
      'Start (or reset) a UCC add-on project in memory. Provide a name; appId is derived (TA_<name>). Call this first, then author globalConfig.json with ucc_write_file.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Add-on name, e.g. "github_audit".' },
        version: { type: 'string', description: 'Semver, default 1.0.0.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'ucc_write_file',
    description:
      'Author or overwrite a project file (e.g. globalConfig.json at the root, package/bin/<input>.py, package/lib/requirements.txt). This is how you build the add-on; the Monaco UI shows the same files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative path, e.g. "globalConfig.json".' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'ucc_read_file',
    description: 'Read one project file back. Returns its content (or a not-found note).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'ucc_list_project',
    description: 'List the files currently in the add-on project.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ucc_build_and_inspect',
    description:
      'Run the self-correcting loop: ucc-gen build -> Splunk AppInspect -> auto-fix -> repeat until AppInspect-CLEAN (or maxIterations). Returns the loop trace + remaining findings, and writes any corrected files back into the project. Author globalConfig.json first.',
    inputSchema: {
      type: 'object',
      properties: {
        maxIterations: { type: 'number', description: 'Default 4.' },
        includeWarnings: {
          type: 'boolean',
          description: 'Treat warnings as actionable. Default true.',
        },
      },
    },
  },
  {
    name: 'ucc_package',
    description:
      'Build + AppInspect-validate with auto-fix and return the path to an installable, AppInspect-clean .tar.gz.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** Execute a tool against the given session. Pure dispatch — transport-agnostic. */
export async function handleBuilderTool(
  session: BuilderSession,
  name: string,
  args: Record<string, unknown>
): Promise<BuilderToolResult> {
  switch (name) {
    case 'ucc_ping':
      return {
        text: `ok — appId: ${session.appId || '(none — call ucc_create_addon)'}, files: ${session.files().length}`,
        data: { ok: true, appId: session.appId, files: session.files().length },
      };

    case 'ucc_create_addon': {
      const appId = deriveAppId(String(args.name ?? ''));
      if (!appId || appId === 'ta_') return { text: 'Error: name is required.', isError: true };
      session.reset(appId, args.version ? String(args.version) : '1.0.0');
      return {
        text: `Created project ${appId} (v${session.version}). Next: ucc_write_file globalConfig.json, then ucc_build_and_inspect.`,
        data: { appId, version: session.version },
      };
    }

    case 'ucc_write_file': {
      if (!session.appId) return { text: 'Error: call ucc_create_addon first.', isError: true };
      const path = String(args.path ?? '');
      if (!path) return { text: 'Error: path is required.', isError: true };
      if (!session.isSafePath(path))
        return {
          text: `Error: path "${path}" is outside the add-on project and was rejected (no absolute paths or ".." traversal).`,
          isError: true,
        };
      session.writeFile(path, String(args.content ?? ''));
      return { text: `Wrote ${path}.`, data: { path } };
    }

    case 'ucc_read_file': {
      const path = String(args.path ?? '');
      if (!path || !session.isSafePath(path))
        return {
          text: `Error: path "${path}" is outside the add-on project and was rejected.`,
          isError: true,
        };
      const content = session.readFile(path);
      if (content === null) return { text: `(${path} not found)`, data: { path, found: false } };
      return { text: content, data: { path, found: true, content } };
    }

    case 'ucc_list_project': {
      const files = session.files();
      return {
        text: files.length
          ? `Project ${session.appId} — ${files.length} file(s):\n${files.map((f) => `  ${f.path}`).join('\n')}`
          : '(empty — author globalConfig.json with ucc_write_file)',
        data: { appId: session.appId, files: files.map((f) => f.path) },
      };
    }

    case 'ucc_build_and_inspect':
    case 'ucc_package': {
      if (!session.appId) return { text: 'Error: call ucc_create_addon first.', isError: true };
      if (session.files().length === 0)
        return { text: 'Error: project is empty — author globalConfig.json first.', isError: true };
      const result = await runAgentLoop({
        sessionId: `mcp-${session.appId}-${Date.now()}`,
        appId: session.appId,
        version: session.version,
        files: session.files(),
        maxIterations: Number.isFinite(Number(args.maxIterations)) ? Number(args.maxIterations) : 4,
        includeWarnings: args.includeWarnings === undefined ? true : Boolean(args.includeWarnings),
      });
      session.syncBack(result.files);
      const trace = result.events
        .map((e) => `  [it${e.iteration}] ${e.kind}: ${e.message}`)
        .join('\n');
      const header = `${name} for ${result.appId}: ${result.clean ? 'AppInspect-CLEAN ✅' : 'NOT clean ❌'} after ${result.iterations} iteration(s).`;
      const pkg = name === 'ucc_package' && result.tarball ? `\n\nPackage: ${result.tarball}` : '';
      return {
        text: `${header}\n\n--- loop trace ---\n${trace}\n\n--- final ---\n${result.finalSummary ?? ''}${pkg}`,
        data: {
          clean: result.clean,
          iterations: result.iterations,
          tarball: name === 'ucc_package' ? result.tarball : undefined,
          summary: result.finalSummary,
        },
      };
    }

    default:
      return { text: `Unknown tool: ${name}`, isError: true };
  }
}
