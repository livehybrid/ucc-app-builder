import { describe, it, expect } from 'vitest';
import { ToolRegistry } from './registry';
import { Tool } from './tools';

describe('ToolRegistry', () => {
  it('should register and retrieve tools', () => {
    const registry = new ToolRegistry();
    const tool: Tool = {
      name: 'test_tool',
      description: 'A test tool',
      parameters: {},
      execute: async () => 'result',
    };

    registry.register(tool);
    expect(registry.get('test_tool')).toBe(tool);
    expect(registry.getAll()).toContain(tool);
  });

  it('should unregister tools', () => {
    const registry = new ToolRegistry();
    const tool: Tool = {
      name: 'test_tool',
      description: 'A test tool',
      parameters: {},
      execute: async () => 'result',
    };

    registry.register(tool);
    registry.unregister('test_tool');
    expect(registry.get('test_tool')).toBeUndefined();
  });

  it('should format for OpenAI', () => {
    const registry = new ToolRegistry();
    const tool: Tool = {
      name: 'test_tool',
      description: 'A test tool',
      parameters: { type: 'object' },
      execute: async () => 'result',
    };

    registry.register(tool);
    const formatted = registry.toOpenAIFormat();
    expect(formatted).toHaveLength(1);
    expect(formatted[0]).toEqual({
      type: 'function',
      function: {
        name: 'test_tool',
        description: 'A test tool',
        parameters: { type: 'object' },
      },
    });
  });
});
