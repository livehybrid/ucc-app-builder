import { Tool } from '../tools';

export interface SuggestedAction {
  label: string;
  prompt: string;
}

export const suggestActions: Tool = {
  name: 'suggest_actions',
  description:
    'Surface 1-3 suggested next-step actions as clickable buttons in the chat UI. ' +
    'Call this at the END of a response (never mid-task) when there are clear follow-on actions the user might want. ' +
    'Each action needs a short button label (≤8 words) and the full prompt to send when clicked.',
  parameters: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        description: 'Suggested next actions to show as buttons.',
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description: 'Button label shown in the UI (≤8 words, imperative verb, e.g. "Store API key as encrypted field").',
            },
            prompt: {
              type: 'string',
              description: 'The message to send when the user clicks this button.',
            },
          },
          required: ['label', 'prompt'],
        },
        minItems: 1,
        maxItems: 3,
      },
    },
    required: ['actions'],
  },
  execute: async (args) => {
    const actions = args.actions as SuggestedAction[];
    if (!Array.isArray(actions) || actions.length === 0) {
      return 'Error: actions must be a non-empty array.';
    }
    return JSON.stringify(actions);
  },
};
