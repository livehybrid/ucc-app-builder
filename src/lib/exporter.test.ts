import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  generateExportSummary,
  createProjectFile,
  exportSourceAsZip,
  createPackageStructure,
} from './exporter';
import { createManifestFromImport } from './importer';
import { VirtualFileSystem } from './vfs';
import type { ImportAnalysis } from '../types/manifest';

describe('generateExportSummary', () => {
  it('should categorize files by origin', () => {
    const analysis: ImportAnalysis = {
      appId: 'test_app',
      displayName: 'Test App',
      version: '1.0.0',
      globalConfig: {},
      isUCCApp: true,
      warnings: [],
      files: [
        { path: 'test_app/package/globalConfig.json', origin: 'source', content: '{}', checksum: 'abc' },
        { path: 'test_app/default/app.conf', origin: 'generated', content: '', checksum: 'def' },
        { path: 'test_app/bin/custom.py', origin: 'custom', content: '', checksum: 'ghi' },
        { path: 'test_app/default/inputs.conf', origin: 'modified-generated', content: '', checksum: 'jkl' },
      ],
    };

    const summary = generateExportSummary(analysis);

    expect(summary.source).toContain('test_app/package/globalConfig.json');
    expect(summary.generated).toContain('test_app/default/app.conf');
    expect(summary.custom).toContain('test_app/bin/custom.py');
    expect(summary.modifiedGenerated).toContain('test_app/default/inputs.conf');
  });

  it('should handle empty file lists', () => {
    const analysis: ImportAnalysis = {
      appId: 'empty_app',
      displayName: 'Empty',
      version: '1.0.0',
      globalConfig: null,
      isUCCApp: false,
      warnings: [],
      files: [],
    };

    const summary = generateExportSummary(analysis);

    expect(summary.source).toHaveLength(0);
    expect(summary.generated).toHaveLength(0);
    expect(summary.custom).toHaveLength(0);
    expect(summary.modifiedGenerated).toHaveLength(0);
  });
});

describe('createProjectFile', () => {
  it('should create a valid project file from analysis', () => {
    const analysis: ImportAnalysis = {
      appId: 'my_app',
      displayName: 'My App',
      version: '2.0.0',
      globalConfig: { meta: { name: 'my_app' } },
      isUCCApp: true,
      warnings: [],
      files: [
        { path: 'my_app/package/globalConfig.json', origin: 'source', content: '{}', checksum: 'abc' },
        { path: 'my_app/bin/helper.py', origin: 'custom', content: '', checksum: 'def' },
      ],
    };

    const project = createProjectFile(analysis, { navBarColor: '#FF0000' });

    expect(project.version).toBe('1.0.0');
    expect(project.metadata.appId).toBe('my_app');
    expect(project.metadata.displayName).toBe('My App');
    expect(project.metadata.version).toBe('2.0.0');
    expect(project.branding.navBarColor).toBe('#FF0000');
    expect(project.globalConfig).toEqual({ meta: { name: 'my_app' } });
    expect(project.customFiles).toContain('my_app/bin/helper.py');
  });

  it('should use default branding if not provided', () => {
    const analysis: ImportAnalysis = {
      appId: 'test',
      displayName: 'Test',
      version: '1.0.0',
      globalConfig: {},
      isUCCApp: true,
      warnings: [],
      files: [],
    };

    const project = createProjectFile(analysis);

    expect(project.branding.navBarColor).toBe('#65A637');
  });

  it('should handle null globalConfig', () => {
    const analysis: ImportAnalysis = {
      appId: 'test',
      displayName: 'Test',
      version: '1.0.0',
      globalConfig: null,
      isUCCApp: false,
      warnings: [],
      files: [],
    };

    const project = createProjectFile(analysis);

    expect(project.globalConfig).toEqual({});
  });
});

describe('exportSourceAsZip', () => {
  it('should create a ZIP with project file and manifest', async () => {
    const analysis: ImportAnalysis = {
      appId: 'export_test',
      displayName: 'Export Test',
      version: '1.0.0',
      globalConfig: { meta: { name: 'export_test' } },
      isUCCApp: true,
      warnings: [],
      files: [
        { path: 'export_test/package/globalConfig.json', origin: 'source', content: '{"test": true}', checksum: 'abc' },
      ],
    };
    const manifest = createManifestFromImport(analysis);

    const blob = await exportSourceAsZip(analysis, manifest);
    const zip = await JSZip.loadAsync(blob);

    expect(zip.files['export_test.uccproject']).toBeDefined();
    expect(zip.files['.uccbuild/manifest.json']).toBeDefined();
  });

  it('should only include source and custom files', async () => {
    const analysis: ImportAnalysis = {
      appId: 'filter_test',
      displayName: 'Filter Test',
      version: '1.0.0',
      globalConfig: {},
      isUCCApp: true,
      warnings: [],
      files: [
        { path: 'filter_test/package/globalConfig.json', origin: 'source', content: '{}', checksum: 'a' },
        { path: 'filter_test/default/app.conf', origin: 'generated', content: '#gen', checksum: 'b' },
        { path: 'filter_test/lookups/data.csv', origin: 'custom', content: 'data', checksum: 'c' },
      ],
    };
    const manifest = createManifestFromImport(analysis);

    const blob = await exportSourceAsZip(analysis, manifest);
    const zip = await JSZip.loadAsync(blob);

    const filenames = Object.keys(zip.files);

    // Should have source file
    expect(filenames.some(f => f.includes('globalConfig.json'))).toBe(true);
    // Should have custom file
    expect(filenames.some(f => f.includes('data.csv'))).toBe(true);
    // Should NOT have generated file (except in restructured form)
    expect(filenames.some(f => f === 'filter_test/default/app.conf')).toBe(false);
  });

  it('should restructure files into package/ directory', async () => {
    const analysis: ImportAnalysis = {
      appId: 'restructure_test',
      displayName: 'Restructure Test',
      version: '1.0.0',
      globalConfig: {},
      isUCCApp: true,
      warnings: [],
      files: [
        { path: 'restructure_test/bin/script.py', origin: 'custom', content: '# script', checksum: 'a' },
      ],
    };
    const manifest = createManifestFromImport(analysis);

    const blob = await exportSourceAsZip(analysis, manifest);
    const zip = await JSZip.loadAsync(blob);

    const filenames = Object.keys(zip.files);

    // Should be restructured to package/bin/
    expect(filenames.some(f => f.includes('package/bin/script.py'))).toBe(true);
  });
});

describe('createPackageStructure', () => {
  it('should convert VFS to package/ structure', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/my_app/default/app.conf', '# config');
    vfs.writeFile('/my_app/bin/input.py', '# script');

    const packageVfs = createPackageStructure(vfs, 'my_app');
    const files = packageVfs.listAllFiles();

    expect(files.some(f => f.path.startsWith('/package/'))).toBe(true);
    expect(packageVfs.exists('/package/default/app.conf')).toBe(true);
    expect(packageVfs.exists('/package/bin/input.py')).toBe(true);
  });

  it('should handle files already in package/ directory', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/my_app/package/globalConfig.json', '{}');

    const packageVfs = createPackageStructure(vfs, 'my_app');

    // Should not double-nest package/package/
    expect(packageVfs.exists('/package/globalConfig.json')).toBe(true);
    expect(packageVfs.exists('/package/package/globalConfig.json')).toBe(false);
  });

  it('should preserve file contents', () => {
    const vfs = new VirtualFileSystem();
    const content = '{"meta": {"name": "test"}}';
    vfs.writeFile('/test_app/config.json', content);

    const packageVfs = createPackageStructure(vfs, 'test_app');

    expect(packageVfs.readFile('/package/config.json')).toBe(content);
  });
});
