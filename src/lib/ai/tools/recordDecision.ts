import { Tool } from '../toolTypes';
import { sessionState } from '../sessionState';

export const recordDecision: Tool = {
  name: 'record_decision',
  description:
    'Record an architectural or design decision the user has approved (e.g. which auth method, which REST endpoint to poll). ' +
    'Decisions persist for the session and are surfaced back to the agent on the next turn so it stays consistent.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Stable identifier (e.g. "auth-method"). Overwrites any previous decision with the same id.',
      },
      question: {
        type: 'string',
        description: 'What question does this decision answer?',
      },
      decision: {
        type: 'string',
        description: 'The chosen answer.',
      },
      rationale: {
        type: 'string',
        description: 'Optional. Why this was chosen.',
      },
    },
    required: ['id', 'question', 'decision'],
  },
  execute: async (args) => {
    const id = args.id as string;
    const question = args.question as string;
    const decision = args.decision as string;
    const rationale = (args.rationale as string | undefined) ?? '';
    if (!id || !question || !decision) {
      return 'Error: id, question, and decision are all required.';
    }
    const rec = sessionState.recordDecision({
      id,
      question,
      decision,
      rationale,
    });
    return `Decision recorded: (${rec.id}) ${rec.question} → ${rec.decision}`;
  },
};
