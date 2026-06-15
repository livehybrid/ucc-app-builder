/**
 * Leaf module for the agent-tool contract: the `Tool` interface, the
 * `ToolContext`, and the path-security helpers.
 *
 * This module imports nothing from the tool implementations or the registry, so
 * it can be imported by every tool under `tools/*` AND by `coreTools.ts` without
 * creating an import cycle. `tools.ts` (the registry bootstrap) re-exports
 * everything here for backward compatibility.
 */

import { VirtualFileSystem } from '../vfs';

/** Context passed to tools (e.g. a UI build trigger). */
export interface ToolContext {
  onBuildTrigger?: () => Promise<void> | void;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    vfs: VirtualFileSystem,
    context?: ToolContext
  ) => Promise<string>;
}

// Security constants
export const ALLOWED_PATH_PREFIXES = ['package/', '/package/'];

// UCC files that must live at the project ROOT (siblings of package/), not inside
// package/. `ucc-gen` reads globalConfig.json from the source root; blocking it
// forces the agent to misfile it into package/ or loop on a write error.
//
// NOTE: `globalConfig.json` is the ONLY root file the builder currently honours —
// the generator writes nothing else at root, and the build path-mapping
// (`server/services/agentLoop.ts` mapVfsPathToDisk) + the exporter only carry
// `globalConfig.json` and `package/...` to disk; any other root file is silently
// dropped. ucc-gen DOES additionally support a few optional root files we could
// add in future — most notably `additional_packaging.py` (a build hook), plus
// `globalConfig.yaml` and `.uccignore`. We deliberately did NOT add them here yet:
// allowlisting them WITHOUT also extending the build mapping + exporter would let
// the agent write a file that never reaches the built app — a worse trap than the
// bug this allowlist fixes. To support one, update all three places together
// (this allowlist, mapVfsPathToDisk, and exporter.ts) and add a test.
export const ALLOWED_ROOT_FILES = ['globalConfig.json'];

export const BLOCKED_ABSOLUTE_PATHS = [
  '/etc/',
  '/usr/',
  '/var/',
  '/bin/',
  '/sbin/',
  '/tmp/',
  '/home/',
  '/root/',
];

export const BLOCKED_PATTERNS = ['..', 'node_modules/', '.git/', '.env'];

/**
 * Read a required string argument from a tool call, returning a model-friendly
 * error message instead of letting the tool crash on `undefined`.
 *
 * Models sometimes emit tool calls with a missing/misnamed/non-string argument
 * (especially when a provider's streaming chunks get merged); without this
 * guard the tool throws `Cannot read properties of undefined (reading
 * 'replace')` — a TypeError the model cannot act on. A clear "missing 'path'"
 * message lets it self-correct on the next attempt.
 */
export function requireStringArg(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
  opts: { allowEmpty?: boolean } = {}
): { ok: true; value: string } | { ok: false; error: string } {
  const v = args[name];
  if (typeof v !== 'string' || (!opts.allowEmpty && !v.trim())) {
    const got = v === undefined ? 'missing' : typeof v;
    return {
      ok: false,
      error:
        `Error: ${toolName} requires a non-empty string "${name}" argument (got: ${got}). ` +
        `Call it again with {"${name}": "..."} — check the argument name and that the value is a plain string.`,
    };
  }
  return { ok: true, value: v };
}

/** Validates that a path is safe for the AI to access. */
export function validatePath(path: string): string | null {
  if (typeof path !== 'string') {
    return 'Security Error: path must be a string.';
  }
  const normalizedPath = path.replace(/\\/g, '/');

  for (const pattern of BLOCKED_ABSOLUTE_PATHS) {
    if (normalizedPath.startsWith(pattern)) {
      return `Security Error: Access to system path "${pattern}" is not allowed.`;
    }
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (normalizedPath.includes(pattern)) {
      return `Security Error: Access to "${pattern}" paths is not allowed.`;
    }
  }

  return null;
}

/** Additional validation for write operations — must be in allowed directories. */
export function validateWritePath(path: string): string | null {
  const baseError = validatePath(path);
  if (baseError) return baseError;

  const normalizedPath = path.replace(/\\/g, '/');

  // Allow UCC root config files (e.g. globalConfig.json) regardless of the
  // package/ prefix — they belong at the source root, beside package/.
  const basename = normalizedPath.split('/').pop() ?? '';
  if (ALLOWED_ROOT_FILES.includes(basename)) {
    return null;
  }

  const isAllowed = ALLOWED_PATH_PREFIXES.some(
    (prefix) => normalizedPath.startsWith(prefix) || normalizedPath.includes(prefix)
  );

  if (!isAllowed) {
    return `Security Error: Write operations are only allowed within the package/ directory or for UCC root files (${ALLOWED_ROOT_FILES.join(', ')}).`;
  }

  return null;
}
