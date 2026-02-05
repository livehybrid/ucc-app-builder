/**
 * Virtual File System types
 */

export interface VFSFile {
  type: 'file';
  name: string;
  path: string;
  content: string;
  language?: string;
}

export interface VFSDirectory {
  type: 'directory';
  name: string;
  path: string;
  children: Map<string, VFSNode>;
}

export type VFSNode = VFSFile | VFSDirectory;

export interface VFSSnapshot {
  files: Array<{ path: string; content: string }>;
}
