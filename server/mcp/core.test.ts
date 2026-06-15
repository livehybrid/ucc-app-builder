import { describe, it, expect } from 'vitest';
import {
  BuilderSession,
  deriveAppId,
  handleBuilderTool,
  BUILDER_TOOLS,
  toSafeProjectPath,
} from './core';

describe('deriveAppId', () => {
  it('derives a TA_-prefixed snake id', () => {
    expect(deriveAppId('GitHub Audit')).toBe('ta_github_audit');
    expect(deriveAppId('ta_already')).toBe('ta_already');
  });
});

describe('handleBuilderTool', () => {
  it('ping reports an empty session before create', async () => {
    const s = new BuilderSession();
    const r = await handleBuilderTool(s, 'ucc_ping', {});
    expect(r.data).toMatchObject({ ok: true, appId: '', files: 0 });
  });

  it('rejects write/build before create_addon', async () => {
    const s = new BuilderSession();
    expect(
      (await handleBuilderTool(s, 'ucc_write_file', { path: 'x', content: 'y' })).isError
    ).toBe(true);
    expect((await handleBuilderTool(s, 'ucc_build_and_inspect', {})).isError).toBe(true);
  });

  it('create → write → list → read round-trips, normalising under the appId root', async () => {
    const s = new BuilderSession();
    const created = await handleBuilderTool(s, 'ucc_create_addon', { name: 'GitHub Audit' });
    expect(created.data).toMatchObject({ appId: 'ta_github_audit' });

    await handleBuilderTool(s, 'ucc_write_file', {
      path: 'globalConfig.json',
      content: '{"meta":{"name":"TA_github_audit"}}',
    });

    const list = await handleBuilderTool(s, 'ucc_list_project', {});
    expect(list.data?.files).toEqual(['/ta_github_audit/globalConfig.json']);

    const read = await handleBuilderTool(s, 'ucc_read_file', { path: 'globalConfig.json' });
    expect(read.data).toMatchObject({ found: true });
    expect(read.text).toContain('TA_github_audit');
  });

  it('read_file returns not-found cleanly', async () => {
    const s = new BuilderSession();
    await handleBuilderTool(s, 'ucc_create_addon', { name: 'x' });
    const r = await handleBuilderTool(s, 'ucc_read_file', { path: 'nope.json' });
    expect(r.data).toMatchObject({ found: false });
  });

  it('guards an empty-project build', async () => {
    const s = new BuilderSession();
    await handleBuilderTool(s, 'ucc_create_addon', { name: 'x' });
    const r = await handleBuilderTool(s, 'ucc_build_and_inspect', {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/empty/i);
  });

  it('unknown tool is an error', async () => {
    const s = new BuilderSession();
    expect((await handleBuilderTool(s, 'nope', {})).isError).toBe(true);
  });

  it('SECURITY: rejects path traversal / absolute paths on write and read', async () => {
    const s = new BuilderSession();
    await handleBuilderTool(s, 'ucc_create_addon', { name: 'x' });
    for (const bad of [
      '../../etc/passwd',
      '/etc/passwd',
      'ta_x/../../../etc/shadow',
      'package/../../secret',
      'a\\..\\b',
      'foo\0.json',
      'good/../../escape',
    ]) {
      const w = await handleBuilderTool(s, 'ucc_write_file', { path: bad, content: 'x' });
      expect(w.isError, `write ${bad}`).toBe(true);
      const r = await handleBuilderTool(s, 'ucc_read_file', { path: bad });
      expect(r.isError, `read ${bad}`).toBe(true);
    }
    // Nothing escaped into the project.
    const list = await handleBuilderTool(s, 'ucc_list_project', {});
    expect(list.data?.files).toEqual([]);
  });

  it('toSafeProjectPath confines to the appId subtree', () => {
    expect(toSafeProjectPath('ta_x', 'globalConfig.json')).toBe('ta_x/globalConfig.json');
    expect(toSafeProjectPath('ta_x', 'package/bin/in.py')).toBe('ta_x/package/bin/in.py');
    expect(toSafeProjectPath('ta_x', 'ta_x/package/app.manifest')).toBe('ta_x/package/app.manifest');
    expect(toSafeProjectPath('ta_x', '../escape')).toBeNull();
    expect(toSafeProjectPath('ta_x', '/abs')).toBeNull(); // absolute paths rejected
    expect(toSafeProjectPath('ta_x', 'a/../b')).toBeNull();
    expect(toSafeProjectPath('ta_x', '')).toBeNull();
  });

  it('every BUILDER_TOOL has a flat object schema (Splunk MCP registration shape)', () => {
    for (const t of BUILDER_TOOLS) {
      expect(t.inputSchema.type).toBe('object');
      expect(JSON.stringify(t.inputSchema)).not.toContain('$ref');
    }
  });
});
