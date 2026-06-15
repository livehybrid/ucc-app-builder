import { Tool } from '../toolTypes';
import { sessionState, Todo, TodoStatus } from '../sessionState';

const VALID_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];

export const todoWrite: Tool = {
  name: 'todo_write',
  description:
    'Create or update the agent todo list so the user can see progress. ' +
    'Use for any multi-step task. Keep exactly one item `in_progress` at a time. ' +
    'Pass `merge=true` to update only the items you supply; `merge=false` (default) replaces the whole list.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Todo items.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: {
              type: 'string',
              enum: VALID_STATUSES,
            },
          },
          required: ['id', 'content', 'status'],
        },
      },
      merge: {
        type: 'boolean',
        description: 'If true, merge with the existing list by id. Default false.',
      },
    },
    required: ['todos'],
  },
  execute: async (args) => {
    const todos = args.todos as Todo[];
    const merge = Boolean(args.merge);

    if (!Array.isArray(todos)) return 'Error: todos must be an array.';

    for (const t of todos) {
      if (!t.id || !t.content || !t.status) {
        return `Error: todo items require id, content, status. Got ${JSON.stringify(t)}`;
      }
      if (!VALID_STATUSES.includes(t.status)) {
        return `Error: invalid status "${t.status}". Must be one of ${VALID_STATUSES.join(', ')}.`;
      }
    }

    const result = merge ? sessionState.mergeTodos(todos) : sessionState.setTodos(todos);

    const inProgress = result.filter((t) => t.status === 'in_progress').length;
    const warning =
      inProgress > 1 ? ` (warning: ${inProgress} items are "in_progress"; prefer exactly 1)` : '';

    return (
      `Todo list updated (${result.length} items).${warning}\n` +
      result.map((t) => `  [${t.status.padEnd(11)}] ${t.content}`).join('\n')
    );
  },
};
