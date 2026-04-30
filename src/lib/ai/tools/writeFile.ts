
import { Tool, validateWritePath } from '../tools';

export const writeFile: Tool = {
  name: 'write_file',
  description: 'Write content to a file within the package/ directory. Use this to create new files or modify existing ones.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The path of the file (must be within package/)' },
      content: { type: 'string', description: 'The full content to write' },
    },
    required: ['path', 'content'],
  },
  execute: async (args, vfs) => {
    const path = args.path as string;
    // Security validation for write operations
    const pathError = validateWritePath(path);
    if (pathError) {
      return pathError;
    }
    
    // Additional content validation - block obvious sensitive data patterns
    const content = args.content as string;
    if (content.includes('BEGIN RSA PRIVATE KEY') || 
        content.includes('BEGIN PRIVATE KEY') ||
        content.includes('-----BEGIN CERTIFICATE-----') && content.includes('-----BEGIN PRIVATE KEY-----')) {
      return 'Security Error: Writing raw private keys is not allowed. Use encrypted storage or Splunk password storage instead.';
    }
    
    vfs.writeFile(path, content, 'user');
    return `Successfully wrote to ${path}`;
  }
};
