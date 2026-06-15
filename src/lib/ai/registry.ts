import { Tool } from './tools';

/**
 * Registry for AI tools. Allows dynamic registration and retrieval.
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * Register a new tool.
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`Tool "${tool.name}" is already registered. Overwriting.`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Unregister a tool by name.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Get a tool by name.
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools.
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools in OpenAI format.
   */
  toOpenAIFormat(): {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }[] {
    return this.getAll().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}

// Export singleton instance
export const toolRegistry = new ToolRegistry();
