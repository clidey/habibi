export interface RecentFile {
  id: string;
  path: string;
  name: string;
  kind: 'file' | 'folder';
  size: number;
  openedAt: string;
  pinned: boolean;
  available?: boolean;
}
export interface ReminderItem {
  id: string;
  title: string;
  due: string | null;
  completed: boolean;
  list: string;
}
export interface FocusState {
  state: 'idle' | 'running' | 'paused' | 'finished';
  remaining: number;
  duration: number;
  label: string;
  visible: boolean;
}
