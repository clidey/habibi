export type FileTask =
  'rename' | 'organize' | 'storage' | 'duplicates' | 'pdf' | 'compress' | 'extract' | 'find';
export interface FileGrant {
  id: string;
  path: string;
  name: string;
  directory: boolean;
  expiresAt: number;
}
export interface FileEntry {
  id: string;
  grantId: string;
  relative: string;
  path: string;
  size: number;
  modified: number;
  device: number;
  inode: number;
  excerpt?: string;
  pages?: number;
}
export interface FileChange {
  kind: 'move' | 'trash' | 'image' | 'pdf' | 'csv';
  sources: string[];
  destination?: string;
  pages?: { source: string; page: number; rotate?: number }[];
  width?: number;
  quality?: number;
  targetBytes?: number;
  csv?: string;
  reason: string;
}
export interface FilePlan {
  id: string;
  task: FileTask;
  summary: string;
  changes: FileChange[];
  findings: { fileId: string; reason: string }[];
  entries: FileEntry[];
  cleanup: boolean;
  createdAt: number;
  expiresAt: number;
  status: 'preview' | 'applied' | 'undone' | 'failed';
  outputs?: string[];
  warning?: string;
}
