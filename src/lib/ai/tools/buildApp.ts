import { Tool } from '../toolTypes';

export const buildApp: Tool = {
  name: 'build_app',
  description:
    'Trigger a full rebuild of the Splunk app distribution package. Use this after modifying configuration or code to apply changes.',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: async (_args, _vfs, context) => {
    if (context && context.onBuildTrigger) {
      // Execute the build trigger
      await context.onBuildTrigger();
      return 'Build triggered successfully. The app package has been regenerated.';
    }
    return 'Error: Build trigger not available in this context.';
  },
};
