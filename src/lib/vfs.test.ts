import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '../lib/vfs';

describe('VirtualFileSystem', () => {
  let vfs: VirtualFileSystem;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
  });

  describe('writeFile', () => {
    it('should create a file at the specified path', () => {
      const file = vfs.writeFile('/app/test.txt', 'hello world');
      expect(file.name).toBe('test.txt');
      expect(file.path).toBe('/app/test.txt');
      expect(file.content).toBe('hello world');
    });

    it('should create nested directories automatically', () => {
      vfs.writeFile('/a/b/c/file.txt', 'content');
      expect(vfs.exists('/a')).toBe(true);
      expect(vfs.exists('/a/b')).toBe(true);
      expect(vfs.exists('/a/b/c')).toBe(true);
      expect(vfs.exists('/a/b/c/file.txt')).toBe(true);
    });

    it('should detect language from file extension', () => {
      expect(vfs.writeFile('/test.py', '').language).toBe('python');
      expect(vfs.writeFile('/test.json', '').language).toBe('json');
      expect(vfs.writeFile('/test.js', '').language).toBe('javascript');
      expect(vfs.writeFile('/test.conf', '').language).toBe('ini');
    });

    it('should reject path traversal attempts', () => {
      expect(() => vfs.writeFile('../etc/passwd', 'hack')).toThrow('Invalid path');
      expect(() => vfs.writeFile('/app/../../../etc/passwd', 'hack')).toThrow('Invalid path');
    });
  });

  describe('readFile', () => {
    it('should return file content', () => {
      vfs.writeFile('/test.txt', 'content');
      expect(vfs.readFile('/test.txt')).toBe('content');
    });

    it('should return null for non-existent files', () => {
      expect(vfs.readFile('/nonexistent.txt')).toBeNull();
    });

    it('should return null for directories', () => {
      vfs.writeFile('/dir/file.txt', 'content');
      expect(vfs.readFile('/dir')).toBeNull();
    });
  });

  describe('exists', () => {
    it('should return true for existing files', () => {
      vfs.writeFile('/test.txt', 'content');
      expect(vfs.exists('/test.txt')).toBe(true);
    });

    it('should return true for existing directories', () => {
      vfs.writeFile('/dir/file.txt', 'content');
      expect(vfs.exists('/dir')).toBe(true);
    });

    it('should return false for non-existent paths', () => {
      expect(vfs.exists('/nonexistent')).toBe(false);
    });
  });

  describe('delete', () => {
    it('should delete a file', () => {
      vfs.writeFile('/test.txt', 'content');
      expect(vfs.delete('/test.txt')).toBe(true);
      expect(vfs.exists('/test.txt')).toBe(false);
    });

    it('should delete a directory', () => {
      vfs.writeFile('/dir/file.txt', 'content');
      expect(vfs.delete('/dir')).toBe(true);
      expect(vfs.exists('/dir')).toBe(false);
    });

    it('should not delete root', () => {
      expect(vfs.delete('/')).toBe(false);
    });
  });

  describe('listAllFiles', () => {
    it('should return all files sorted by path', () => {
      vfs.writeFile('/b/file.txt', '1');
      vfs.writeFile('/a/file.txt', '2');
      vfs.writeFile('/c.txt', '3');

      const files = vfs.listAllFiles();
      expect(files.map((f) => f.path)).toEqual(['/a/file.txt', '/b/file.txt', '/c.txt']);
    });
  });

  describe('snapshot', () => {
    it('should export and import correctly', () => {
      vfs.writeFile('/a/test.txt', 'content1');
      vfs.writeFile('/b/test.json', '{"key": "value"}');

      const snapshot = vfs.toSnapshot();
      expect(snapshot.files).toHaveLength(2);

      const newVfs = new VirtualFileSystem();
      newVfs.fromSnapshot(snapshot);

      expect(newVfs.readFile('/a/test.txt')).toBe('content1');
      expect(newVfs.readFile('/b/test.json')).toBe('{"key": "value"}');
    });
  });

  describe('clear', () => {
    it('should remove all files', () => {
      vfs.writeFile('/a.txt', '1');
      vfs.writeFile('/b/c.txt', '2');
      vfs.clear();
      expect(vfs.listAllFiles()).toHaveLength(0);
    });
  });
});
