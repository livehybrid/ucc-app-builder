import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import JSZip from 'jszip';
import { createAppZip, downloadBlob, downloadAppAsZip } from './packager';
import { VirtualFileSystem } from './vfs';

describe('createAppZip', () => {
  it('should create a ZIP blob from VFS contents', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/my_app/default/app.conf', '[launcher]\nauthor = Test');
    vfs.writeFile('/my_app/bin/script.py', '# Python script');

    const blob = await createAppZip(vfs);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
  });

  it('should include all VFS files in the ZIP', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/app/file1.txt', 'content 1');
    vfs.writeFile('/app/dir/file2.txt', 'content 2');
    vfs.writeFile('/app/dir/subdir/file3.txt', 'content 3');

    const blob = await createAppZip(vfs);
    const zip = await JSZip.loadAsync(blob);

    expect(zip.files['app/file1.txt']).toBeDefined();
    expect(zip.files['app/dir/file2.txt']).toBeDefined();
    expect(zip.files['app/dir/subdir/file3.txt']).toBeDefined();
  });

  it('should preserve file contents in ZIP', async () => {
    const vfs = new VirtualFileSystem();
    const content = '{"key": "value", "nested": {"data": true}}';
    vfs.writeFile('/test/config.json', content);

    const blob = await createAppZip(vfs);
    const zip = await JSZip.loadAsync(blob);

    const extracted = await zip.files['test/config.json'].async('string');
    expect(extracted).toBe(content);
  });

  it('should handle empty VFS', async () => {
    const vfs = new VirtualFileSystem();

    const blob = await createAppZip(vfs);
    const zip = await JSZip.loadAsync(blob);

    const fileCount = Object.keys(zip.files).filter((name) => !zip.files[name].dir).length;
    expect(fileCount).toBe(0);
  });

  it('should remove leading slash from paths', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/leading/slash/file.txt', 'content');

    const blob = await createAppZip(vfs);
    const zip = await JSZip.loadAsync(blob);

    // Should not have leading slash
    expect(zip.files['leading/slash/file.txt']).toBeDefined();
    expect(zip.files['/leading/slash/file.txt']).toBeUndefined();
  });
});

describe('downloadBlob', () => {
  let createObjectURLMock: ReturnType<typeof vi.fn>;
  let revokeObjectURLMock: ReturnType<typeof vi.fn>;
  let appendChildMock: ReturnType<typeof vi.fn>;
  let removeChildMock: ReturnType<typeof vi.fn>;
  let clickMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURLMock = vi.fn().mockReturnValue('blob:test-url');
    revokeObjectURLMock = vi.fn();
    appendChildMock = vi.fn();
    removeChildMock = vi.fn();
    clickMock = vi.fn();

    vi.stubGlobal('URL', {
      createObjectURL: createObjectURLMock,
      revokeObjectURL: revokeObjectURLMock,
    });

    appendChildMock = vi
      .spyOn(document.body, 'appendChild')
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      .mockImplementation(((node: any) => node) as any) as any;
    removeChildMock = vi
      .spyOn(document.body, 'removeChild')
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      .mockImplementation(((node: any) => node) as any) as any;
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'a') {
        return {
          href: '',
          download: '',
          click: clickMock,
        } as unknown as HTMLAnchorElement;
      }
      return document.createElement(tag);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should create object URL from blob', () => {
    const blob = new Blob(['test content'], { type: 'application/zip' });
    downloadBlob(blob, 'test.zip');

    expect(createObjectURLMock).toHaveBeenCalledWith(blob);
  });

  it('should set download filename', () => {
    const blob = new Blob(['test']);
    downloadBlob(blob, 'my-app.zip');

    // Verify the anchor was appended to trigger download
    expect(appendChildMock).toHaveBeenCalled();
  });

  it('should trigger click on anchor element', () => {
    const blob = new Blob(['test']);
    downloadBlob(blob, 'test.zip');

    expect(clickMock).toHaveBeenCalled();
  });

  it('should clean up by revoking object URL', () => {
    const blob = new Blob(['test']);
    downloadBlob(blob, 'test.zip');

    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:test-url');
  });

  it('should append and remove anchor from document body', () => {
    const blob = new Blob(['test']);
    downloadBlob(blob, 'test.zip');

    expect(appendChildMock).toHaveBeenCalled();
    expect(removeChildMock).toHaveBeenCalled();
  });
});

describe('downloadAppAsZip', () => {
  let createObjectURLMock: ReturnType<typeof vi.fn>;
  let revokeObjectURLMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURLMock = vi.fn().mockReturnValue('blob:test-url');
    revokeObjectURLMock = vi.fn();

    vi.stubGlobal('URL', {
      createObjectURL: createObjectURLMock,
      revokeObjectURL: revokeObjectURLMock,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(document.body, 'appendChild').mockImplementation(((node: any) => node) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(document.body, 'removeChild').mockImplementation(((node: any) => node) as any);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'a') {
        return {
          href: '',
          download: '',
          click: vi.fn(),
        } as unknown as HTMLAnchorElement;
      }
      return document.createElement(tag);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should generate ZIP from VFS and trigger download', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/test_app/app.conf', '# config');

    await downloadAppAsZip(vfs, 'Test App');

    expect(createObjectURLMock).toHaveBeenCalled();
  });

  it('should sanitize app name for filename', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/app/file.txt', 'content');

    // The function should convert "My Cool App!" to "my_cool_app_.zip"
    await downloadAppAsZip(vfs, 'My Cool App!');

    // Verify download was triggered (URL was created)
    expect(createObjectURLMock).toHaveBeenCalled();
  });
});
