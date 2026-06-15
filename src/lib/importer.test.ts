import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  importAppFromZip,
  classifyFileOrigin,
  createManifestFromImport,
  extractSourceFiles,
} from './importer';

// Helper to create a mock ZIP file
async function createMockZip(files: Record<string, string>): Promise<File> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], 'test.zip', { type: 'application/zip' });
}

describe('classifyFileOrigin', () => {
  const appId = 'my_app';

  describe('source files', () => {
    it('should classify globalConfig.json as source', () => {
      expect(classifyFileOrigin('my_app/globalConfig.json', appId)).toBe('source');
    });

    it('should classify app.manifest as source', () => {
      expect(classifyFileOrigin('my_app/package/app.manifest', appId)).toBe('source');
    });

    it('should classify package/ directory files as source', () => {
      expect(classifyFileOrigin('my_app/package/bin/my_input.py', appId)).toBe('source');
      expect(classifyFileOrigin('my_app/package/default/inputs.conf', appId)).toBe('source');
    });
  });

  describe('generated files', () => {
    it('should classify app.conf as generated', () => {
      expect(classifyFileOrigin('my_app/default/app.conf', appId)).toBe('generated');
    });

    it('should classify nav XML as generated', () => {
      expect(classifyFileOrigin('my_app/default/data/ui/nav/default.xml', appId)).toBe('generated');
    });

    it('should classify restmap.conf as generated', () => {
      expect(classifyFileOrigin('my_app/default/restmap.conf', appId)).toBe('generated');
    });
  });

  describe('custom files', () => {
    it('should classify unknown files as custom', () => {
      expect(classifyFileOrigin('my_app/lookups/data.csv', appId)).toBe('custom');
      expect(classifyFileOrigin('my_app/appserver/static/custom.js', appId)).toBe('custom');
    });

    it('should classify non-package bin files as custom', () => {
      expect(classifyFileOrigin('my_app/bin/custom_script.sh', appId)).toBe('custom');
    });
  });
});

describe('importAppFromZip', () => {
  it('should parse ZIP and extract files', async () => {
    const zipFile = await createMockZip({
      'my_app/globalConfig.json': JSON.stringify({
        meta: { name: 'my_app', displayName: 'My App', version: '1.0.0' },
        pages: {},
      }),
      'my_app/default/app.conf': '[launcher]\nauthor = Test',
      'my_app/bin/input.py': '# Python script',
    });

    const analysis = await importAppFromZip(zipFile);

    expect(analysis.appId).toBe('my_app');
    expect(analysis.displayName).toBe('My App');
    expect(analysis.version).toBe('1.0.0');
    expect(analysis.isUCCApp).toBe(true);
    expect(analysis.files.length).toBe(3);
  });

  it('should detect UCC apps by globalConfig.json presence', async () => {
    const uccZip = await createMockZip({
      'my_app/globalConfig.json': JSON.stringify({
        meta: { name: 'my_app', displayName: 'UCC App', version: '2.0.0' },
        pages: {},
      }),
    });

    const nonUccZip = await createMockZip({
      'my_app/default/app.conf': '[launcher]\nauthor = Test',
    });

    const uccAnalysis = await importAppFromZip(uccZip);
    const nonUccAnalysis = await importAppFromZip(nonUccZip);

    expect(uccAnalysis.isUCCApp).toBe(true);
    expect(uccAnalysis.globalConfig).not.toBeNull();
    expect(nonUccAnalysis.isUCCApp).toBe(false);
    expect(nonUccAnalysis.globalConfig).toBeNull();
  });

  it('should extract metadata from app.conf when no globalConfig', async () => {
    const zipFile = await createMockZip({
      'test_addon/default/app.conf': `[launcher]
author = Test Author
version = 3.0.0

[ui]
label = Test Add-on`,
    });

    const analysis = await importAppFromZip(zipFile);

    expect(analysis.displayName).toBe('Test Add-on');
    expect(analysis.version).toBe('3.0.0');
  });

  it('should classify files correctly during import', async () => {
    const zipFile = await createMockZip({
      'my_app/globalConfig.json': '{}',
      'my_app/package/bin/custom_input.py': '# source',
      'my_app/default/app.conf': '# generated',
      'my_app/lookups/data.csv': '# custom',
    });

    const analysis = await importAppFromZip(zipFile);

    const globalConfigFile = analysis.files.find((f) => f.path.includes('globalConfig.json'));
    const customInputFile = analysis.files.find((f) => f.path.includes('custom_input.py'));
    const appConfFile = analysis.files.find((f) => f.path.includes('app.conf'));
    const lookupFile = analysis.files.find((f) => f.path.includes('data.csv'));

    expect(globalConfigFile?.origin).toBe('source');
    expect(customInputFile?.origin).toBe('source');
    expect(appConfFile?.origin).toBe('generated');
    expect(lookupFile?.origin).toBe('custom');
  });

  it('should import binary files as base64', async () => {
    const zipFile = await createMockZip({
      'my_app/globalConfig.json': '{}',
      'my_app/static/logo.png': 'fake binary data',
    });

    const analysis = await importAppFromZip(zipFile);

    // Binary files should now be included, not skipped
    const pngFile = analysis.files.find((f) => f.path.endsWith('logo.png'));
    expect(pngFile).toBeDefined();
    expect(pngFile!.content).toBeTruthy(); // base64 encoded
    expect(analysis.warnings.some((w) => w.includes('Binary file skipped'))).toBe(false);
  });

  it('should handle malformed JSON in globalConfig gracefully', async () => {
    const zipFile = await createMockZip({
      'my_app/globalConfig.json': '{ invalid json }',
    });

    const analysis = await importAppFromZip(zipFile);

    expect(analysis.warnings.some((w) => w.includes('Could not parse globalConfig.json'))).toBe(
      true
    );
    expect(analysis.globalConfig).toBeNull();
  });
});

describe('createManifestFromImport', () => {
  it('should create a valid manifest from analysis', async () => {
    const zipFile = await createMockZip({
      'my_app/globalConfig.json': JSON.stringify({
        meta: { name: 'my_app', displayName: 'My App', version: '1.0.0' },
      }),
      'my_app/default/app.conf': '# config',
    });

    const analysis = await importAppFromZip(zipFile);
    const manifest = createManifestFromImport(analysis);

    expect(manifest.version).toBe('1.0.0');
    expect(manifest.appId).toBe('my_app');
    expect(manifest.displayName).toBe('My App');
    expect(manifest.files.length).toBe(2);
    expect(manifest.build.builderVersion).toBe('0.1.0');
  });

  it('should track checksums for all files', async () => {
    const zipFile = await createMockZip({
      'my_app/globalConfig.json': '{"test": true}',
    });

    const analysis = await importAppFromZip(zipFile);
    const manifest = createManifestFromImport(analysis);

    const file = manifest.files[0];
    expect(file.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should mark generatedChecksum for generated files', async () => {
    const zipFile = await createMockZip({
      'my_app/globalConfig.json': '{}',
      'my_app/default/app.conf': '# generated',
    });

    const analysis = await importAppFromZip(zipFile);
    const manifest = createManifestFromImport(analysis);

    const sourceFile = manifest.files.find((f) => f.origin === 'source');
    const generatedFile = manifest.files.find((f) => f.origin === 'generated');

    expect(sourceFile?.generatedChecksum).toBeUndefined();
    expect(generatedFile?.generatedChecksum).toBeDefined();
  });
});

describe('extractSourceFiles', () => {
  it('should return only source and custom files', async () => {
    const zipFile = await createMockZip({
      'my_app/globalConfig.json': '{}',
      'my_app/package/bin/input.py': '# source',
      'my_app/default/app.conf': '# generated',
      'my_app/lookups/data.csv': '# custom',
    });

    const analysis = await importAppFromZip(zipFile);
    const sourceFiles = extractSourceFiles(analysis);

    expect(sourceFiles.length).toBe(3); // globalConfig, input.py, data.csv
    expect(sourceFiles.every((f) => f.origin !== 'generated')).toBe(true);
  });

  it('should include modified-generated files', async () => {
    const zipFile = await createMockZip({
      'my_app/globalConfig.json': '{}',
    });

    const analysis = await importAppFromZip(zipFile);
    // Manually mark a file as modified-generated for testing
    analysis.files.push({
      path: 'my_app/default/inputs.conf',
      origin: 'modified-generated',
      content: '# modified',
      checksum: 'abc123',
    });

    const sourceFiles = extractSourceFiles(analysis);

    expect(sourceFiles.some((f) => f.origin === 'modified-generated')).toBe(true);
  });
});
