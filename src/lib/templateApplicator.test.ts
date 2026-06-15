import { describe, it, expect } from 'vitest';
import { applyTemplate } from './templateApplicator';
import type { ComponentsConfig } from '../types/components';
import { DEFAULT_COMPONENTS_CONFIG } from '../types/components';
import type { Template } from '../types/templates';

function makeTemplate(overrides: Partial<Template> = {}): Template {
  return {
    metadata: {
      id: 'test-template',
      name: 'Test Template',
      description: 'A test template',
      category: 'custom',
      icon: '🧪',
      tags: [],
      difficulty: 'beginner',
      version: '1.0.0',
    },
    inputs: [],
    documentation: '',
    addsSummary: [],
    ...overrides,
  };
}

function makeInputTemplate(name: string, script = '# {{INPUT_NAME}}') {
  return {
    config: {
      name,
      title: `${name} Title`,
      description: `${name} description`,
      entity: [
        { field: 'name', label: 'Name', type: 'text' as const, required: true },
        { field: 'interval', label: 'Interval', type: 'text' as const, required: true },
        { field: 'index', label: 'Index', type: 'text' as const, required: true },
      ],
    },
    pythonScript: script,
  };
}

describe('applyTemplate', () => {
  it('should add a single input from template', () => {
    const template = makeTemplate({
      inputs: [makeInputTemplate('my_input')],
    });

    const result = applyTemplate(DEFAULT_COMPONENTS_CONFIG, template);

    expect(result.config.inputs).toHaveLength(1);
    expect(result.config.inputs[0].name).toBe('my_input');
    expect(result.summary).toContain('Added input: "my_input Title"');
  });

  it('should generate python script for each input', () => {
    const template = makeTemplate({
      inputs: [makeInputTemplate('my_input', '# script for {{INPUT_NAME}}')],
    });

    const result = applyTemplate(DEFAULT_COMPONENTS_CONFIG, template);

    expect(result.scriptsToAdd['package/bin/my_input.py']).toBe('# script for my_input');
  });

  it('should hydrate all template variables in python script', () => {
    const script =
      'class {{CLASS_NAME}}:\n    name = "{{INPUT_NAME}}"\n    title = "{{INPUT_TITLE}}"\n    desc = "{{INPUT_DESCRIPTION}}"';
    const template = makeTemplate({
      inputs: [makeInputTemplate('api_poll', script)],
    });

    const result = applyTemplate(DEFAULT_COMPONENTS_CONFIG, template);
    const generated = result.scriptsToAdd['package/bin/api_poll.py'];

    expect(generated).toContain('class ApiPollInput');
    expect(generated).toContain('name = "api_poll"');
    expect(generated).toContain('title = "api_poll Title"');
  });

  it('should generate unique names when input name already exists', () => {
    const existing: ComponentsConfig = {
      ...DEFAULT_COMPONENTS_CONFIG,
      inputs: [
        {
          name: 'my_input',
          title: 'Existing',
          entity: [],
        },
      ],
    };

    const template = makeTemplate({
      inputs: [makeInputTemplate('my_input')],
    });

    const result = applyTemplate(existing, template);

    expect(result.config.inputs).toHaveLength(2);
    expect(result.config.inputs[1].name).toBe('my_input_2');
  });

  it('should add helper scripts when provided', () => {
    const template = makeTemplate({
      inputs: [
        {
          ...makeInputTemplate('my_input'),
          helperScript: '# helper code',
        },
      ],
    });

    const result = applyTemplate(DEFAULT_COMPONENTS_CONFIG, template);

    expect(result.scriptsToAdd['package/bin/my_input_helper.py']).toBe('# helper code');
    expect(result.summary).toContain('Added helper: bin/my_input_helper.py');
  });

  it('should add accounts from template', () => {
    const template = makeTemplate({
      accounts: [
        {
          config: {
            name: 'api_account',
            authType: 'apikey' as const,
            fields: [
              {
                field: 'api_key',
                label: 'API Key',
                type: 'password' as const,
                required: true,
                encrypted: true,
              },
            ],
          },
        },
      ],
    });

    const result = applyTemplate(DEFAULT_COMPONENTS_CONFIG, template);

    expect(result.config.accounts).toHaveLength(1);
    expect(result.config.accounts[0].name).toBe('api_account');
    expect(result.summary).toContain('Added account: "api_account"');
  });

  it('should skip duplicate accounts', () => {
    const existing: ComponentsConfig = {
      ...DEFAULT_COMPONENTS_CONFIG,
      accounts: [
        {
          name: 'api_account',
          authType: 'apikey',
          fields: [],
        },
      ],
    };

    const template = makeTemplate({
      accounts: [
        {
          config: {
            name: 'api_account',
            authType: 'apikey' as const,
            fields: [],
          },
        },
      ],
    });

    const result = applyTemplate(existing, template);

    expect(result.config.accounts).toHaveLength(1); // Not duplicated
    expect(result.summary.some((s) => s.includes('Skipped') || s.includes('already exists'))).toBe(
      true
    );
  });

  it('should enable logging when recommended', () => {
    const template = makeTemplate({
      recommendedTabs: { enableLogging: true },
    });

    const result = applyTemplate(DEFAULT_COMPONENTS_CONFIG, template);

    expect(result.config.logging.enabled).toBe(true);
    expect(result.summary).toContain('Enabled logging configuration');
  });

  it('should enable proxy when recommended', () => {
    const template = makeTemplate({
      recommendedTabs: { enableProxy: true },
    });

    const result = applyTemplate(DEFAULT_COMPONENTS_CONFIG, template);

    expect(result.config.proxy.enabled).toBe(true);
    expect(result.summary).toContain('Enabled proxy configuration');
  });

  it('should not re-enable logging if already enabled', () => {
    const existing: ComponentsConfig = {
      ...DEFAULT_COMPONENTS_CONFIG,
      logging: { ...DEFAULT_COMPONENTS_CONFIG.logging, enabled: true },
    };

    const template = makeTemplate({
      recommendedTabs: { enableLogging: true },
    });

    const result = applyTemplate(existing, template);

    expect(result.summary).not.toContain('Enabled logging');
  });

  it('should preserve existing inputs when adding new ones', () => {
    const existing: ComponentsConfig = {
      ...DEFAULT_COMPONENTS_CONFIG,
      inputs: [
        {
          name: 'existing_input',
          title: 'Existing',
          entity: [],
        },
      ],
    };

    const template = makeTemplate({
      inputs: [makeInputTemplate('new_input')],
    });

    const result = applyTemplate(existing, template);

    expect(result.config.inputs).toHaveLength(2);
    expect(result.config.inputs[0].name).toBe('existing_input');
    expect(result.config.inputs[1].name).toBe('new_input');
  });
});
