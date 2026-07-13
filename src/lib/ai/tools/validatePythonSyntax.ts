import { Tool } from '../tools';

export const validatePythonSyntax: Tool = {
  name: 'validate_python_syntax',
  description:
    'Check a Python script for syntax errors using the Python AST parser BEFORE writing it to the VFS. ' +
    'Returns "OK" or a detailed error with the line number. ' +
    'Always call this before write_file for any .py file.',
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The Python source code to validate.',
      },
      filename: {
        type: 'string',
        description: 'Optional filename shown in error messages (e.g. "my_input.py").',
      },
    },
    required: ['content'],
  },
  execute: async (args) => {
    const content = String(args.content ?? '');
    const filename = String(args.filename ?? '<string>');

    if (!content.trim()) return 'OK (empty file)';

    try {
      const res = await fetch('/api/ai/validate-python', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, filename }),
      });

      if (!res.ok) {
        return `Server error ${res.status} — cannot validate syntax right now.`;
      }

      const data = await res.json() as { ok: boolean; error?: string };
      if (data.ok) return `OK — no syntax errors in ${filename}`;
      return `SyntaxError in ${filename}:\n${data.error ?? '(unknown error)'}`;
    } catch {
      return 'validate_python_syntax requires server-managed mode. Skipping syntax check.';
    }
  },
};
