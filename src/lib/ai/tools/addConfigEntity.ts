import { Tool } from '../toolTypes';

export const addConfigEntity: Tool = {
  name: 'add_config_entity',
  description: 'Generate a globalConfig.json entity (field) entry with proper UCC format.',
  parameters: {
    type: 'object',
    properties: {
      field_name: { type: 'string', description: 'Name of the field (e.g., api_key)' },
      label: { type: 'string', description: 'UI Label for the field' },
      field_type: {
        type: 'string',
        description: 'Type of field',
        enum: ['text', 'password', 'checkbox', 'singleSelect', 'multipleSelect', 'radio'],
      },
      help_text: { type: 'string', description: 'Help text displayed under the field' },
      default_value: { type: 'string', description: 'Default value (optional)' },
      encrypted: { type: 'boolean', description: 'Whether to encrypt the field (for passwords)' },
      required: { type: 'boolean', description: 'Whether the field is required' },
      options: {
        type: 'array',
        description: 'Options for select/radio fields',
        items: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            label: { type: 'string' },
          },
        },
      },
      validators: {
        type: 'array',
        description: 'Array of validator objects',
      },
    },
    required: ['field_name', 'label', 'field_type'],
  },
  execute: async (args, _vfs) => {
    const field_name = args.field_name as string;
    const label = args.label as string;
    const field_type = args.field_type as string;

    // Map simplified types to UCC types
    const typeMap: Record<string, string> = {
      text: 'text',
      password: 'text', // In UCC, password is text + encrypted: true
      checkbox: 'checkbox',
      singleSelect: 'singleSelect',
      multipleSelect: 'multipleSelect',
      radio: 'radio',
    };

    const uccType = typeMap[field_type] || 'text';
    const encrypted = args.encrypted !== undefined ? args.encrypted : field_type === 'password';

    const entity: Record<string, unknown> = {
      field: field_name,
      label: label,
      type: uccType,
      help: args.help_text || undefined,
      defaultValue: args.default_value || undefined,
      encrypted: encrypted || undefined,
      required: args.required || undefined,
      options: args.options || undefined,
      validators: args.validators || undefined,
    };

    // Remove undefined keys
    Object.keys(entity).forEach((key) => {
      if (entity[key] === undefined) delete entity[key];
    });

    return JSON.stringify(entity, null, 2);
  },
};
