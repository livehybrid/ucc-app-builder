
/**
 * Main entry point for AI Tools.
 * Re-exports the ToolRegistry and initializes it with all available tools.
 * 
 * This file replaces the old monolithic tools definition.
 */

import { VirtualFileSystem } from '../vfs';
import { toolRegistry } from './registry';

// Import all tools
import { listFiles } from './tools/listFiles';
import { readFile } from './tools/readFile';
import { writeFile } from './tools/writeFile';
import { generateInputScript } from './tools/generateInputScript';
import { addConfigEntity } from './tools/addConfigEntity';
import { getSplunklibHelp } from './tools/getSplunklibHelp';
import { getSplunkSdkReference } from './tools/getSplunkSdkReference';
import { buildApp } from './tools/buildApp';
import { consultDocumentation } from './tools/consultDocumentation';
import { applyPatch } from './tools/applyPatch';
import { createFile } from './tools/createFile';
import { todoWrite } from './tools/todoWrite';
import { recordDecision } from './tools/recordDecision';
import { readMemory, writeMemory } from './tools/readMemory';
import { getStanzaSpec, listStanzas } from './tools/getStanzaSpec';
import {
  runUccGen,
  runAppInspect,
  installToSplunkDocker,
  browserCheck,
} from './tools/verifyTools';
import { validateUccConformance } from './tools/validateUccConformance';
import { suggestActions } from './tools/suggestActions';
import { searchFiles } from './tools/searchFiles';
import { moveFile } from './tools/moveFile';
import { diffFile } from './tools/diffFile';
import { checkpointVfs, restoreCheckpoint, listCheckpoints } from './tools/checkpointVfs';
import { validatePythonSyntax } from './tools/validatePythonSyntax';
import { getAppInspectRules } from './tools/getAppInspectRules';
import { getExampleConf } from './tools/getExampleConf';

// Context passed to tools
export interface ToolContext {
  onBuildTrigger?: () => Promise<void> | void;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, vfs: VirtualFileSystem, context?: ToolContext) => Promise<string>;
}

// Security constants
export const ALLOWED_PATH_PREFIXES = [
  'package/',
  '/package/',
];

export const BLOCKED_ABSOLUTE_PATHS = [
  '/etc/', '/usr/', '/var/', '/bin/', '/sbin/', '/tmp/', '/home/', '/root/',
];

export const BLOCKED_PATTERNS = [
  '..', 'node_modules/', '.git/', '.env',
];

/**
 * Validates that a path is safe for the AI to access.
 */
export function validatePath(path: string): string | null {
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

/**
 * Additional validation for write operations - must be in allowed directories
 */
export function validateWritePath(pathValue: string): string | null {
  const err = validatePath(pathValue);
  if (err) return err;
  const path = pathValue.replace(/\\/g, '/');
  const isInPackage = path.startsWith('package/') || path.startsWith('/package/') || path.includes('/package/');
  const isGlobalConfig = path === 'globalConfig.json' || path.endsWith('/globalConfig.json');
  if (!isInPackage && !isGlobalConfig) {
    return 'Security Error: write operations are only allowed within package/ or to globalConfig.json.';
  }
  return null;
}
// Register all tools
toolRegistry.register(listFiles);
toolRegistry.register(readFile);
toolRegistry.register(writeFile);
toolRegistry.register(generateInputScript);
toolRegistry.register(addConfigEntity);
toolRegistry.register(getSplunklibHelp);
toolRegistry.register(getSplunkSdkReference);
toolRegistry.register(buildApp);
toolRegistry.register(consultDocumentation);
// v2 primitives — see docs/research/00-synthesis.md
toolRegistry.register(applyPatch);
toolRegistry.register(createFile);
toolRegistry.register(todoWrite);
toolRegistry.register(recordDecision);
toolRegistry.register(readMemory);
toolRegistry.register(writeMemory);
toolRegistry.register(getStanzaSpec);
toolRegistry.register(listStanzas);
// Verify-and-install loop (server-backed).
toolRegistry.register(runUccGen);
toolRegistry.register(runAppInspect);
toolRegistry.register(installToSplunkDocker);
toolRegistry.register(browserCheck);
toolRegistry.register(validateUccConformance);
toolRegistry.register(suggestActions);
// Developer productivity tools
toolRegistry.register(searchFiles);
toolRegistry.register(moveFile);
toolRegistry.register(diffFile);
toolRegistry.register(checkpointVfs);
toolRegistry.register(restoreCheckpoint);
toolRegistry.register(listCheckpoints);
toolRegistry.register(validatePythonSyntax);
toolRegistry.register(getAppInspectRules);
toolRegistry.register(getExampleConf);

// Export the registry singleton as the default list (for backward compatibility where needed)
// But mostly consumers should use toolRegistry.getAll()
export const TOOLS = toolRegistry.getAll();
export { toolRegistry };
