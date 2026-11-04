export interface Note {
  id: string;
  title: string;
  body: string;
  /** Legacy page emoji, retained for existing libraries. */
  emoji: string;
  icon?: string;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revision: number;
}
export interface NoteFolder {
  id: string;
  name: string;
  parentId: string | null;
}
export interface NotesLibrary {
  version: 1;
  notes: Note[];
  folders: NoteFolder[];
  /** Manual page order, created when the user first organizes pages. */
  noteOrder?: string[];
}
