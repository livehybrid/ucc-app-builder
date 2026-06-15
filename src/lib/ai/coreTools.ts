/**
 * CORE_AGENT_TOOLS — the single, canonical definition of the primitive agent
 * tools shared by BOTH execution surfaces:
 *
 *   - the server-side tool-calling loop (server/routes/ai.ts → agentRunner), and
 *   - the browser-side fallback registry (src/lib/ai/tools.ts) used when the user
 *     brings their own OpenRouter key instead of the server-managed proxy.
 *
 * These tools are isomorphic: they operate purely on the in-memory
 * VirtualFileSystem and session state, with no node-only or DOM-only imports, so
 * the SAME definitions run in Node and in the browser. The server appends its
 * privileged integration tools (MCP-as-tools, build_and_inspect) on top of this
 * set; the browser registry appends its server-backed helpers (build_app,
 * verify tools, doc/stanza lookups) on top of the same set.
 *
 * Before this module the primitives were defined twice (a thinner inline copy in
 * routes/ai.ts and the richer copy under src/lib/ai/tools/*). This is now the one
 * place they live.
 */

import type { Tool } from './toolTypes';
import { listFiles } from './tools/listFiles';
import { readFile } from './tools/readFile';
import { writeFile } from './tools/writeFile';
import { createFile } from './tools/createFile';
import { applyPatch } from './tools/applyPatch';
import { getSplunklibHelp } from './tools/getSplunklibHelp';
import { getSplunkSdkReference } from './tools/getSplunkSdkReference';
import { validateUccConformance } from './tools/validateUccConformance';
import { todoWrite } from './tools/todoWrite';
import { recordDecision } from './tools/recordDecision';
import { readMemory, writeMemory } from './tools/readMemory';

/**
 * The canonical core tool set. Order is stable so both surfaces present the same
 * tool list to the model.
 */
export const CORE_AGENT_TOOLS: Tool[] = [
  listFiles,
  readFile,
  writeFile,
  createFile,
  applyPatch,
  getSplunklibHelp,
  getSplunkSdkReference,
  validateUccConformance,
  todoWrite,
  recordDecision,
  readMemory,
  writeMemory,
];
