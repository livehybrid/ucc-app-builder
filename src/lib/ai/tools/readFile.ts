
import { Tool, validatePath } from '../tools';

export const readFile: Tool = {
  name: 'read_file',
  description: 'Read the content of a specific file within the project. Use this to examine existing code.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The path of the file to read (within package/)' },
    },
    required: ['path'],
  },
  execute: async (args, vfs) => {
    // Security validation
    const path = args.path as string;
    const pathError = validatePath(path);
    if (pathError) {
      return pathError;
    }
    
    const content = vfs.readFile(path);
    if (content === null) {
      return `Error: File not found: ${path}`;
    }
    
    // Truncate if too large to prevent overflow
    if (content.length > 20000) {
        return `WARNING: File is too large (${content.length} chars). Showing first 20k chars:\n\n` + 
               content.substring(0, 20000) + 
               `\n\n... (truncated ${content.length - 20000} chars)`;
    }
    
    return content;
  },
};
