/**
 * Main entry point for AI Tools.
 * Re-exports the ToolRegistry and initializes it with all available tools.
 *
 * This file replaces the old monolithic tools definition.
 */

import { toolRegistry } from './registry';

// The tool contract + path-security helpers live in the leaf module toolTypes.ts
// (no cycle with the tool implementations). Re-exported here for back-compat with
// the many `import { Tool, validatePath } from '../tools'` call sites.
export type { Tool, ToolContext } from './toolTypes';
export {
  validatePath,
  validateWritePath,
  ALLOWED_PATH_PREFIXES,
  BLOCKED_ABSOLUTE_PATHS,
  BLOCKED_PATTERNS,
} from './toolTypes';

// The PRIMITIVE tools (list/read/write/create/apply_patch/help/sdk-ref/
// validate/todo/decision/memory) are defined ONCE in coreTools.ts and shared
// with the server-side agent loop (server/routes/ai.ts). The browser registry
// registers that canonical set, then adds the browser-only, server-backed
// helpers below (build_app, doc/stanza lookups, verify tools, the input/entity
// generators). This is the single source of truth for the shared tools.
import { CORE_AGENT_TOOLS } from './coreTools';

// Browser-only tools (call back to the server over HTTP, or are UI-driven).
import { generateInputScript } from './tools/generateInputScript';
import { addConfigEntity } from './tools/addConfigEntity';
import { buildApp } from './tools/buildApp';
import { consultDocumentation } from './tools/consultDocumentation';
import { getStanzaSpec, listStanzas } from './tools/getStanzaSpec';
import { runUccGen, runAppInspect, installToSplunkDocker, browserCheck } from './tools/verifyTools';

// 1. Canonical primitives — the single shared definition (also used server-side).
for (const tool of CORE_AGENT_TOOLS) {
  toolRegistry.register(tool);
}

// 2. Browser-only helpers (server-backed over HTTP or UI-driven).
toolRegistry.register(generateInputScript);
toolRegistry.register(addConfigEntity);
toolRegistry.register(buildApp);
toolRegistry.register(consultDocumentation);
toolRegistry.register(getStanzaSpec);
toolRegistry.register(listStanzas);
// Verify-and-install loop (server-backed).
toolRegistry.register(runUccGen);
toolRegistry.register(runAppInspect);
toolRegistry.register(installToSplunkDocker);
toolRegistry.register(browserCheck);

// Export the registry singleton as the default list (for backward compatibility where needed)
// But mostly consumers should use toolRegistry.getAll()
export const TOOLS = toolRegistry.getAll();
export { toolRegistry };
