import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '../lib/vfs';
import { generateSplunkApp, appManifestFromGlobalConfig } from '../lib/generator';
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
      email: 'test@example.com',
      version: '1.0.0',
      appId: 'test_app',
      licenseName: 'Apache-2.0',
      licenseUri: 'https://www.apache.org/licenses/LICENSE-2.0',
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

  // --- AppInspect-clean packaging regressions (the §1 input-bearing fix) ---

  it('declares the input table-header fields as entities even when the input arrives with NO fields (MCP add_input path)', () => {
    // Reproduces the MCP `add_input` shape: an input with an empty entity list.
    // UCC requires every inputs table.header column (except `disabled`, which it
    // injects) to be a declared entity, or the globalConfig is schema-invalid.
    const options: GeneratorOptions = {
      ...baseOptions,
      components: {
        ...DEFAULT_COMPONENTS_CONFIG,
        inputs: [{ name: 'github_repos', title: 'GitHub Repos', entity: [] }],
      },
    };

    generateSplunkApp(vfs, options);
    const config = JSON.parse(vfs.readFile('/test_app/globalConfig.json')!);

    const service = config.pages.inputs.services[0];
    const declared = new Set<string>(service.entity.map((e: { field: string }) => e.field));
    // name/interval/index must now be declared (disabled is UCC-injected).
    for (const f of ['name', 'interval', 'index']) {
      expect(declared.has(f)).toBe(true);
    }
    // Every table-header field except `disabled` must be backed by a declared entity.
    for (const h of config.pages.inputs.table.header as { field: string }[]) {
      if (h.field === 'disabled') continue;
      expect(declared.has(h.field)).toBe(true);
    }
  });

  it('does NOT clobber caller-supplied input fields when normalising', () => {
    const options: GeneratorOptions = {
      ...baseOptions,
      components: {
        ...DEFAULT_COMPONENTS_CONFIG,
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
      },
    };
    generateSplunkApp(vfs, options);
    const config = JSON.parse(vfs.readFile('/test_app/globalConfig.json')!);
    const fields = (config.pages.inputs.services[0].entity as { field: string }[]).map(
      (e) => e.field
    );
    expect(fields).toContain('api_token'); // caller field preserved
    expect(fields).toContain('name'); // standard fields still added
    expect(fields).toContain('index');
  });

  it('never emits metadata/local.meta (AppInspect check_for_local_meta would FAIL)', () => {
    generateSplunkApp(vfs, baseOptions);
    expect(vfs.exists('/test_app/package/metadata/local.meta')).toBe(false);
    expect(vfs.exists('/test_app/package/metadata/default.meta')).toBe(true);
  });

  it('default.meta grants passwords access to sc_admin too (check_kos_are_accessible)', () => {
    generateSplunkApp(vfs, baseOptions);
    const meta = vfs.readFile('/test_app/package/metadata/default.meta')!;
    const passwordsStanza = meta.slice(meta.indexOf('[passwords]'));
    expect(passwordsStanza).toContain('sc_admin');
  });

  it('does not write a non-image file into package/static/ (check_static_directory_file_allow_list)', () => {
    generateSplunkApp(vfs, baseOptions); // no processedIcons -> previously wrote static/README
    expect(vfs.exists('/test_app/package/static/README')).toBe(false);
  });

  it('pins solnlib<8 in requirements.txt to avoid AArch64-incompatible native binaries', () => {
    const options: GeneratorOptions = {
      ...baseOptions,
      components: {
        ...DEFAULT_COMPONENTS_CONFIG,
        inputs: [{ name: 'in1', title: 'In1', entity: [] }],
      },
    };
    generateSplunkApp(vfs, options);
    const reqs = vfs.readFile('/test_app/package/lib/requirements.txt')!;
    expect(reqs).toMatch(/solnlib>=5\.0\.0,<8/);
    expect(reqs).toMatch(/splunktaucclib>=6\.6\.0,<9/);
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

describe('appManifestFromGlobalConfig', () => {
  it('derives a valid manifest from globalConfig meta', () => {
    const manifest = appManifestFromGlobalConfig({
      meta: {
        name: 'TA_my_addon',
        version: '4.2.0',
        displayName: 'My Add-on',
        description: 'Pulls data from an API',
      },
    }) as {
      schemaVersion: string;
      info: { id: { name: string; version: string }; title: string; description: string };
      supportedDeployments: string[];
    };

    expect(manifest.schemaVersion).toBe('2.0.0');
    expect(manifest.info.id.name).toBe('TA_my_addon');
    expect(manifest.info.id.version).toBe('4.2.0');
    expect(manifest.info.title).toBe('My Add-on');
    expect(manifest.info.description).toBe('Pulls data from an API');
    expect(manifest.supportedDeployments).toContain('_standalone');
  });

  it('falls back to the provided appId and sensible defaults when meta is sparse', () => {
    const manifest = appManifestFromGlobalConfig({ meta: {} }, 'TA_fallback') as {
      info: { id: { name: string; version: string }; title: string };
    };
    expect(manifest.info.id.name).toBe('TA_fallback');
    expect(manifest.info.id.version).toBe('1.0.0');
    expect(manifest.info.title).toBe('TA_fallback');
  });

  it('handles a null globalConfig with a final default appId', () => {
    const manifest = appManifestFromGlobalConfig(null) as { info: { id: { name: string } } };
    expect(manifest.info.id.name).toBe('splunk_addon');
  });
});
