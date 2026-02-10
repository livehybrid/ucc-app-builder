import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '../lib/vfs';
import { generateSplunkApp } from '../lib/generator';
import type { GeneratorOptions } from '../lib/generator';
import { DEFAULT_COMPONENTS_CONFIG } from '../types/components';

describe('generateSplunkApp', () => {
  let vfs: VirtualFileSystem;

  const baseOptions: GeneratorOptions = {
    metadata: {
      name: 'Test App',
      displayName: 'Test App Display',
      description: 'A test application',
      author: 'Test Author',
      version: '1.0.0',
      appId: 'test_app',
    },
    branding: {
      navBarColor: '#FF5733',
    },
    components: { ...DEFAULT_COMPONENTS_CONFIG },
  };

  beforeEach(() => {
    vfs = new VirtualFileSystem();
  });

  it('should generate basic app structure', () => {
    generateSplunkApp(vfs, baseOptions);

    expect(vfs.exists('/test_app/globalConfig.json')).toBe(true);
    expect(vfs.exists('/test_app/package/default/app.conf')).toBe(true);
    expect(vfs.exists('/test_app/package/README.txt')).toBe(true);
    expect(vfs.exists('/test_app/package/app.manifest')).toBe(true);
  });

  it('should generate valid globalConfig.json', () => {
    generateSplunkApp(vfs, baseOptions);

    const content = vfs.readFile('/test_app/globalConfig.json');
    expect(content).not.toBeNull();

    const config = JSON.parse(content!);
    expect(config.meta.name).toBe('test_app');
    expect(config.meta.displayName).toBe('Test App Display');
    expect(config.meta.version).toBe('1.0.0');
  });

  it('should include nav color in navigation XML', () => {
    generateSplunkApp(vfs, baseOptions);

    const navXml = vfs.readFile('/test_app/package/default/data/ui/nav/default.xml');
    expect(navXml).toContain('color="#FF5733"');
  });

  it('should include app.conf with correct metadata', () => {
    generateSplunkApp(vfs, baseOptions);

    const appConf = vfs.readFile('/test_app/package/default/app.conf');
    expect(appConf).toContain('author = Test Author');
    expect(appConf).toContain('version = 1.0.0');
    expect(appConf).toContain('label = Test App Display');
  });

  it('should add configuration page when auth is enabled', () => {
    const options: GeneratorOptions = {
      ...baseOptions,
      components: {
        ...DEFAULT_COMPONENTS_CONFIG,
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
      },
    };

    generateSplunkApp(vfs, options);

    const content = vfs.readFile('/test_app/globalConfig.json');
    const config = JSON.parse(content!);

    expect(config.pages.configuration).toBeDefined();
    expect(config.pages.configuration.tabs[0].name).toBe('account');
  });

  it('should add inputs page when modular inputs enabled', () => {
    const options: GeneratorOptions = {
      ...baseOptions,
      components: {
        ...DEFAULT_COMPONENTS_CONFIG,
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
      },
    };

    generateSplunkApp(vfs, options);

    const content = vfs.readFile('/test_app/globalConfig.json');
    const config = JSON.parse(content!);

    expect(config.pages.inputs).toBeDefined();
    expect(config.pages.inputs.table).toBeDefined();
  });

  it('should add alerts when alert actions enabled', () => {
    const options: GeneratorOptions = {
      ...baseOptions,
      components: {
        ...DEFAULT_COMPONENTS_CONFIG,
        alertActions: [
          {
            name: 'example_alert',
            label: 'Example Alert',
            description: 'An example alert action',
            entity: [],
          },
        ],
      },
    };

    generateSplunkApp(vfs, options);

    const content = vfs.readFile('/test_app/globalConfig.json');
    const config = JSON.parse(content!);

    expect(config.alerts).toBeDefined();
    expect(config.alerts).toHaveLength(1);
    expect(config.alerts[0].name).toBe('example_alert');
  });

  it('should create bin directory when modular inputs or custom commands enabled', () => {
    const options: GeneratorOptions = {
      ...baseOptions,
      components: {
        ...DEFAULT_COMPONENTS_CONFIG,
        inputs: [
          {
            name: 'example_input',
            title: 'Example Input',
            entity: [],
          },
        ],
      },
    };

    generateSplunkApp(vfs, options);

    expect(vfs.exists('/test_app/package/bin/example_input.py')).toBe(true);
  });

  it('should not create file named "bin" when command filename is empty or reserved', () => {
    const options: GeneratorOptions = {
      ...baseOptions,
      components: {
        ...DEFAULT_COMPONENTS_CONFIG,
        commands: [
          { name: 'mycmd', filename: '', type: 'streaming', chunked: true },
          { name: 'other', filename: 'bin', type: 'streaming', chunked: true },
        ],
      },
    };

    expect(() => generateSplunkApp(vfs, options)).not.toThrow();

    const binNode = vfs.getNode('/test_app/package/bin');
    expect(binNode?.type).toBe('directory');
    expect(vfs.exists('/test_app/package/bin/mycmd.py')).toBe(true);
    expect(vfs.exists('/test_app/package/bin/other.py')).toBe(true);

    const commandsConf = vfs.readFile('/test_app/package/default/commands.conf');
    expect(commandsConf).toContain('filename = mycmd.py');
    expect(commandsConf).toContain('filename = other.py');
  });

  it('should derive appId from name if not provided', () => {
    const options: GeneratorOptions = {
      ...baseOptions,
      metadata: { ...baseOptions.metadata, appId: '', name: 'My Cool App' },
    };

    generateSplunkApp(vfs, options);

    expect(vfs.exists('/my_cool_app/globalConfig.json')).toBe(true);
  });
});
