import { describe, it, expect } from 'vitest';
import { CORE_AGENT_TOOLS } from './coreTools';
import { toolRegistry } from './tools';

/**
 * Single-source-of-truth guard for the agent tool set.
 *
 * The primitive tools are defined ONCE in coreTools.ts. Both execution surfaces
 * consume that one definition:
 *   - the browser-side fallback registry (src/lib/ai/tools.ts), asserted here, and
 *   - the server-side agent loop (server/routes/ai.ts → SERVER_TOOLS), which
 *     spreads CORE_AGENT_TOOLS and is asserted in server/routes/ai.test.ts.
 *
 * If anyone re-introduces a duplicate inline copy of a primitive, this fails.
 */
describe('CORE_AGENT_TOOLS — single source of truth', () => {
  it('exposes the canonical primitive tools with unique names', () => {
    const names = CORE_AGENT_TOOLS.map((t) => t.name);
    // The 12 isomorphic primitives shared by both surfaces.
    expect(names).toEqual([
      'list_files',
      'read_file',
      'write_file',
      'create_file',
      'apply_patch',
      'get_splunklib_help',
      'get_splunk_sdk_reference',
      'validate_ucc_conformance',
      'todo_write',
      'record_decision',
      'read_memory',
      'write_memory',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('the browser registry registers the SAME tool instances (not a copy)', () => {
    for (const tool of CORE_AGENT_TOOLS) {
      // Identity check: the registry holds the exact object from coreTools, so
      // there is provably one definition, not a parallel re-implementation.
      expect(toolRegistry.get(tool.name)).toBe(tool);
    }
  });

  it('every core tool is a well-formed OpenAI function tool', () => {
    for (const tool of CORE_AGENT_TOOLS) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.execute).toBe('function');
      expect(tool.parameters).toMatchObject({ type: 'object' });
    }
  });
});
