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
    expect(config.meta.schemaVersion).toBe('0.0.10');
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
            {
              field: 'password',
              label: 'Password',
              type: 'password',
              required: true,
              encrypted: true,
            },
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
    expect(config.pages.dashboard).toBeDefined();
  });

  it('maps a `password` field to a `text` entity with encrypted=true (UCC has no password type)', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      inputs: [
        {
          name: 'api_input',
          title: 'API Input',
          entity: [
            {
              field: 'api_token',
              label: 'API Token',
              type: 'password',
              required: true,
              encrypted: true,
            },
          ],
        },
      ],
    };
    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);
    const tokenEntity = config.pages.inputs?.services?.[0].entity.find(
      (e) => e.field === 'api_token'
    );
    expect(tokenEntity?.type).toBe('text'); // NOT 'password' — ucc-gen would reject that
    expect(tokenEntity?.encrypted).toBe(true);
  });

  it('maps account `password` fields to text+encrypted too', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      accounts: [
        {
          name: 'account',
          authType: 'basic',
          fields: [
            { field: 'username', label: 'Username', type: 'text', required: true },
            {
              field: 'password',
              label: 'Password',
              type: 'password',
              required: true,
              encrypted: true,
            },
          ],
        },
      ],
    };
    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);
    const pw = config.pages.configuration?.tabs?.[0].entity?.find((e) => e.field === 'password');
    expect(pw?.type).toBe('text');
    expect(pw?.encrypted).toBe(true);
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

  // --- Additional coverage ---

  it('should add logging tab when logging enabled', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      logging: { enabled: true, defaultLevel: 'DEBUG' },
    };

    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);

    expect(config.pages.configuration).toBeDefined();
    const loggingTab = config.pages.configuration?.tabs?.find((t) => t.name === 'logging');
    expect(loggingTab).toBeDefined();
    expect(loggingTab?.title).toBe('Logging');
    const logLevelEntity = loggingTab?.entity?.find((e) => e.field === 'loglevel');
    expect(logLevelEntity?.defaultValue).toBe('DEBUG');
  });

  it('should add proxy tab when proxy enabled', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      proxy: { enabled: true, proxyType: 'http', host: '', port: '' },
    };

    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);

    const proxyTab = config.pages.configuration?.tabs?.find((t) => t.name === 'proxy');
    expect(proxyTab).toBeDefined();
    expect(proxyTab?.entity?.some((e) => e.field === 'proxy_url')).toBe(true);
  });

  it('should add socks5-specific fields for proxy', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      proxy: { enabled: true, proxyType: 'socks5', host: '', port: '' },
    };

    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);

    const proxyTab = config.pages.configuration?.tabs?.find((t) => t.name === 'proxy');
    expect(proxyTab?.entity?.some((e) => e.field === 'proxy_rdns')).toBe(true);
  });

  it('should add custom tabs', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      customTabs: [
        {
          name: 'custom_settings',
          title: 'Custom Settings',
          entity: [
            { field: 'api_url', label: 'API URL', type: 'text', required: true, help: 'Enter URL' },
          ],
        },
      ],
    };

    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);

    const customTab = config.pages.configuration?.tabs?.find((t) => t.name === 'custom_settings');
    expect(customTab).toBeDefined();
    expect(customTab?.entity?.[0].field).toBe('api_url');
  });

  it('should map entity field options for singleSelect', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      customTabs: [
        {
          name: 'test',
          title: 'Test',
          entity: [
            {
              field: 'dropdown',
              label: 'Dropdown',
              type: 'singleSelect',
              options: {
                items: [
                  { label: 'Option A', value: 'a' },
                  { label: 'Option B', value: 'b' },
                ],
                placeholder: 'Select one',
                referenceName: 'myRef',
                dependencies: ['field1'],
                endpointUrl: '/api/data',
                labelField: 'name',
                valueField: 'id',
              },
            },
          ],
        },
      ],
    };

    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);

    const entity = config.pages.configuration?.tabs?.[0].entity?.[0];
    expect(entity?.options?.items).toHaveLength(2);
    expect(entity?.options?.placeholder).toBe('Select one');
    expect(entity?.options?.referenceName).toBe('myRef');
  });

  it('should map entity field options for multipleSelect', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      customTabs: [
        {
          name: 'test',
          title: 'Test',
          entity: [
            {
              field: 'multi',
              label: 'Multi',
              type: 'multipleSelect',
              options: {
                items: [{ label: 'A', value: 'a' }],
                createSearchChoice: true,
                allowList: '^[a-z]+$',
                denyList: '^admin$',
              },
            },
          ],
        },
      ],
    };

    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);

    const entity = config.pages.configuration?.tabs?.[0].entity?.[0];
    expect(entity?.options?.createSearchChoice).toBe(true);
    expect(entity?.options?.allowList).toBe('^[a-z]+$');
    expect(entity?.options?.denyList).toBe('^admin$');
  });

  it('should map entity validators', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      customTabs: [
        {
          name: 'test',
          title: 'Test',
          entity: [
            {
              field: 'url_field',
              label: 'URL',
              type: 'text',
              validators: [
                { type: 'string', minLength: 1, maxLength: 255, errorMsg: 'Invalid length' },
                { type: 'regex', pattern: '^https://' },
              ],
            },
          ],
        },
      ],
    };

    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);

    const entity = config.pages.configuration?.tabs?.[0].entity?.[0];
    expect(entity?.validators).toHaveLength(2);
    expect(entity?.validators?.[0].minLength).toBe(1);
    expect(entity?.validators?.[0].maxLength).toBe(255);
    expect(entity?.validators?.[0].errorMsg).toBe('Invalid length');
    expect(entity?.validators?.[1].pattern).toBe('^https://');
  });

  it('should map checkbox entity options', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      customTabs: [
        {
          name: 'test',
          title: 'Test',
          entity: [
            {
              field: 'enabled',
              label: 'Enabled',
              type: 'checkbox',
              options: { placeholder: 'Toggle this' },
            },
          ],
        },
      ],
    };

    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);

    const entity = config.pages.configuration?.tabs?.[0].entity?.[0];
    expect(entity?.options?.placeholder).toBe('Toggle this');
  });

  it('should map file entity options', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      customTabs: [
        {
          name: 'test',
          title: 'Test',
          entity: [
            {
              field: 'cert_file',
              label: 'Certificate',
              type: 'file',
              options: { placeholder: 'Upload cert' },
            },
          ],
        },
      ],
    };

    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);

    const entity = config.pages.configuration?.tabs?.[0].entity?.[0];
    expect(entity?.options?.placeholder).toBe('Upload cert');
  });

  it('should set alert icon to appIcon.png by default when no iconPath', () => {
    const components: ComponentsConfig = {
      ...emptyComponents,
      alertActions: [
        {
          name: 'my_alert',
          label: 'My Alert',
          entity: [],
        },
      ],
    };

    const config = createGlobalConfig('my_app', 'My App', '1.0.0', components);

    expect(config.alerts?.[0].icon).toBe('appIcon.png');
  });
});
