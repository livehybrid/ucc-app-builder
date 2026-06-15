import { describe, expect, it } from 'vitest';
import { VirtualFileSystem } from '../../vfs';
import { validateUccConformance } from './validateUccConformance';

function createBaseVfs(): VirtualFileSystem {
  const vfs = new VirtualFileSystem();
  vfs.writeFile(
    '/demo/globalConfig.json',
    JSON.stringify({
      pages: {
        inputs: {
          services: [{ name: 'demo_input', title: 'Demo Input' }],
        },
      },
    })
  );
  return vfs;
}

describe('validateUccConformance tool', () => {
  it('returns pass when required UCC files exist', async () => {
    const vfs = createBaseVfs();
    vfs.writeFile(
      '/demo/package/bin/demo_input.py',
      'import import_declare_test\nfrom splunktaucclib.modinput_wrapper import base_modinput\n'
    );
    vfs.writeFile(
      '/demo/package/bin/demo_input_helper.py',
      'def collect_events(helper, ew):\n    return\n'
    );
    vfs.writeFile('/demo/package/default/app.conf', '[app]\n');
    vfs.writeFile('/demo/package/metadata/default.meta', '[]\n');

    const result = await validateUccConformance.execute({}, vfs);
    expect(result).toContain('UCC conformance: PASS');
  });

  it('returns failures when modular input script missing', async () => {
    const vfs = createBaseVfs();
    const result = await validateUccConformance.execute({}, vfs);
    expect(result).toContain('UCC conformance: FAIL');
    expect(result).toContain('Missing main modular input script');
  });
});
