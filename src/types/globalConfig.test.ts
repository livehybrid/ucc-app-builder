import { describe, it, expect } from 'vitest';
import { createGlobalConfig } from '../types/globalConfig';
import type { ComponentsConfig } from '../types/components';
import { DEFAULT_COMPONENTS_CONFIG } from '../types/components';

describe('createGlobalConfig', () => {
  const emptyComponents: ComponentsConfig = { ...DEFAULT_COMPONENTS_CONFIG };

  it('should create minimal config with correct meta', () => {
    const config = createGlobalConfig('my_app', 'My App', '1.0.0', emptyComponents);

    expect(config.meta.name).toBe('my_app');
    expect(config.meta.displayName).toBe('My App');
    expect(config.meta.version).toBe('1.0.0');
    expect(config.meta.schemaVersion).toBe('0.0.3');
  });

  it('should create config without pages when no options enabled', () => {
    const config = createGlobalConfig('my_app', 'My App', '1.0.0', emptyComponents);

    expect(config.pages.configuration).toBeUndefined();
    expect(config.pages.inputs).toBeUndefined();
    expect(config.alerts).toBeUndefined();
  });

  it('should add account tab when auth enabled', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      accounts: [
        {
          name: 'account',
          authType: 'basic',
          fields: [
            { field: 'username', label: 'Username', type: 'text', required: true },
            { field: 'password', label: 'Password', type: 'password', required: true, encrypted: true },
          ],
        },
      ],
    };

    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);

    expect(config.pages.configuration).toBeDefined();
    expect(config.pages.configuration?.tabs).toHaveLength(1);
    expect(config.pages.configuration?.tabs?.[0].name).toBe('account');

    const entities = config.pages.configuration?.tabs?.[0].entity;
    expect(entities?.some((e) => e.field === 'username')).toBe(true);
    expect(entities?.some((e) => e.field === 'password')).toBe(true);
  });

  it('should add inputs page with table when inputs enabled', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      inputs: [
        {
          name: 'example_input',
          title: 'Example Input',
          entity: [
            { field: 'name', label: 'Name', type: 'text', required: true },
            { field: 'interval', label: 'Interval', type: 'text', required: true },
            { field: 'index', label: 'Index', type: 'text', required: true },
          ],
        },
      ],
    };

    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);

    expect(config.pages.inputs).toBeDefined();
    expect(config.pages.inputs?.table).toBeDefined();
    expect(config.pages.inputs?.table?.actions).toContain('edit');
  });

  it('should add alerts array when alert actions enabled', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      alertActions: [
        {
          name: 'example_alert',
          label: 'Example Alert',
          description: 'An example alert action',
          entity: [],
        },
      ],
    };

    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);

    expect(config.alerts).toBeDefined();
    expect(config.alerts).toHaveLength(1);
    expect(config.alerts?.[0].name).toBe('example_alert');
  });
});
