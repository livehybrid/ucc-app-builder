import { Tool, validateWritePath, requireStringArg } from '../toolTypes';

export const writeFile: Tool = {
  name: 'write_file',
  description:
    'Write content to a file in the app source. Paths start with the app id (use the exact paths list_files shows). App contents live under <appId>/package/ (app.manifest, bin/, default/, lib/, …). The one exception is globalConfig.json, which MUST live at the project root (a sibling of package/, NOT inside it — e.g. "<appId>/globalConfig.json") — that is where ucc-gen reads it. Use this to create new files or modify existing ones.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'The file path, starting with the app id — e.g. "<appId>/package/bin/input.py", or "<appId>/globalConfig.json" for the root config.',
      },
      content: { type: 'string', description: 'The full content to write' },
    },
    required: ['path', 'content'],
  },
  execute: async (args, vfs) => {
    const pathArg = requireStringArg(args, 'path', 'write_file');
    if (!pathArg.ok) return pathArg.error;
    const path = pathArg.value;
    // Security validation for write operations
    const pathError = validateWritePath(path);
    if (pathError) {
      return pathError;
    }

    const contentArg = requireStringArg(args, 'content', 'write_file', { allowEmpty: true });
    if (!contentArg.ok) return contentArg.error;
    // Additional content validation - block obvious sensitive data patterns
    const content = contentArg.value;
    if (
      content.includes('BEGIN RSA PRIVATE KEY') ||
      content.includes('BEGIN PRIVATE KEY') ||
      (content.includes('-----BEGIN CERTIFICATE-----') &&
        content.includes('-----BEGIN PRIVATE KEY-----'))
    ) {
      return 'Security Error: Writing raw private keys is not allowed. Use encrypted storage or Splunk password storage instead.';
    }

    vfs.writeFile(path, content, 'user');
    return `Successfully wrote to ${path}`;
  },
};
