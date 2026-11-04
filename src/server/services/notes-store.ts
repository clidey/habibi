import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Note, NoteFolder, NotesLibrary } from '../../contracts/notes';

export class NotesError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const idPattern = /^[a-f0-9-]{36}$/i;
const iconPattern = /^[a-z][a-z0-9-]{0,79}$/;
const iconName = (value: unknown): string => {
  if (typeof value !== 'string' || !iconPattern.test(value)) throw new NotesError('Choose a valid page icon.');
  return value;
};
const maximumBytes = 24 * 1024 * 1024;
const empty = (): NotesLibrary => ({ version: 1, notes: [], folders: [] });
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NotesError('Invalid note data.');
  return value as Record<string, unknown>;
};
const text = (value: unknown, limit: number, fallback = ''): string => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) throw new NotesError('A note field is invalid or too long.');
  return value;
};
function folderTarget(value: unknown, library: NotesLibrary): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !library.folders.some(folder => folder.id === value)) throw new NotesError('Choose an existing folder.');
  return value;
}
function validateLibrary(value: unknown): NotesLibrary {
  const data = object(value);
  if (data.version !== 1 || !Array.isArray(data.notes) || !Array.isArray(data.folders) || data.notes.length > 5000 || data.folders.length > 500) throw new NotesError('The notes library could not be read. Your file has not been changed.', 500);
  const library = data as unknown as NotesLibrary;
  const ids = new Set<string>();
  for (const folder of library.folders) {
    if (!folder || typeof folder.id !== 'string' || !idPattern.test(folder.id) || ids.has(folder.id) || typeof folder.name !== 'string' || !folder.name.trim() || folder.name.length > 100) throw new NotesError('The notes library needs recovery. Your file has not been changed.', 500);
    ids.add(folder.id);
  }
  for (const folder of library.folders) {
    const visited = new Set([folder.id]);
    let parent = folder.parentId;
    while (parent !== null) {
      if (visited.has(parent) || visited.size > 32) throw new NotesError('The folder structure is invalid. Your file has not been changed.', 500);
      visited.add(parent);
      const next = library.folders.find(item => item.id === parent);
      if (!next) throw new NotesError('The folder structure is invalid. Your file has not been changed.', 500);
      parent = next.parentId;
    }
  }
  for (const note of library.notes) {
    if (!note || typeof note.id !== 'string' || !idPattern.test(note.id) || ids.has(note.id) || typeof note.title !== 'string' || note.title.length > 200 || typeof note.body !== 'string' || note.body.length > 262144 || typeof note.emoji !== 'string' || note.emoji.length > 16 || (note.icon !== undefined && (typeof note.icon !== 'string' || !iconPattern.test(note.icon))) || !Number.isSafeInteger(note.revision) || note.revision < 1 || !Number.isFinite(Date.parse(note.createdAt)) || !Number.isFinite(Date.parse(note.updatedAt)) || (note.deletedAt !== null && !Number.isFinite(Date.parse(note.deletedAt)))) throw new NotesError('The notes library needs recovery. Your file has not been changed.', 500);
    folderTarget(note.folderId, library);
    ids.add(note.id);
  }
  const noteIds = new Set(library.notes.map(note => note.id));
  if (library.noteOrder !== undefined && (!Array.isArray(library.noteOrder) || library.noteOrder.length > library.notes.length || new Set(library.noteOrder).size !== library.noteOrder.length || library.noteOrder.some(id => typeof id !== 'string' || !noteIds.has(id)))) throw new NotesError('The notes library order is invalid. Your file has not been changed.', 500);
  return library;
}

/** Atomic, private storage. Serial writes plus per-note revisions prevent lost edits. */
export function createNotesStore(root: string) {
  const directory = path.join(root, '.habibi', 'notes');
  const file = path.join(directory, 'library.json');
  let pending: Promise<unknown> = Promise.resolve();
  async function read(): Promise<NotesLibrary> {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) throw new Error('Invalid store');
      return validateLibrary(JSON.parse(await fs.readFile(file, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
      if (error instanceof NotesError) throw error;
      throw new NotesError('The notes library could not be read. Your file has not been changed.', 500);
    }
  }
  function mutate<T>(change: (library: NotesLibrary) => T): Promise<T> {
    const operation = pending.then(async () => {
      const library = await read();
      const result = change(library);
      const serialized = JSON.stringify(library);
      if (Buffer.byteLength(serialized) > maximumBytes) throw new NotesError('The notes library is full. Export notes before adding more.');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      const temporary = path.join(directory, `${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, file);
      } catch {
        await fs.unlink(temporary).catch(() => {});
        throw new NotesError('Could not save this note. Your previous library is unchanged.', 500);
      }
      return result;
    });
    pending = operation.catch(() => {});
    return operation;
  }
  function existing(library: NotesLibrary, id: string, revision: unknown): Note {
    const note = library.notes.find(item => item.id === id);
    if (!note) throw new NotesError('This note no longer exists.', 404);
    if (revision !== note.revision) throw new NotesError('This note changed elsewhere. Copy your draft before reloading it.', 409);
    return note;
  }
  return {
    async list() { await pending; return read(); },
    create(value: unknown) {
      const data = object(value);
      return mutate(library => {
        if (library.notes.length >= 5000) throw new NotesError('The notes library is full.');
        const now = new Date().toISOString();
        const note: Note = { id: randomUUID(), title: text(data.title, 200, 'Untitled').trim() || 'Untitled', body: text(data.body, 262144), emoji: text(data.emoji, 16, '📝'), ...(data.icon !== undefined ? { icon: iconName(data.icon) } : {}), folderId: folderTarget(data.folderId, library), createdAt: now, updatedAt: now, deletedAt: null, revision: 1 };
        library.notes.push(note); library.noteOrder?.unshift(note.id); return note;
      });
    },
    update(id: string, value: unknown) {
      const data = object(value);
      return mutate(library => {
        const note = existing(library, id, data.revision);
        if (note.deletedAt) throw new NotesError('Restore this note before editing it.');
        if (data.title !== undefined) note.title = text(data.title, 200).trim() || 'Untitled';
        if (data.body !== undefined) note.body = text(data.body, 262144);
        if (data.icon !== undefined) note.icon = iconName(data.icon);
        if (data.emoji !== undefined) note.emoji = text(data.emoji, 16);
        if (data.folderId !== undefined) note.folderId = folderTarget(data.folderId, library);
        note.updatedAt = new Date().toISOString(); note.revision += 1; return note;
      });
    },
    organize(value: unknown) {
      const data = object(value);
      return mutate(library => {
        if (!Array.isArray(data.notes) || !data.notes.length || data.notes.length > 100) throw new NotesError('Choose up to 100 notes to organize.');
        const notes = data.notes.map(value => {
          const ref = object(value);
          if (typeof ref.id !== 'string') throw new NotesError('Choose existing notes.');
          const note = existing(library, ref.id, ref.revision);
          if (note.deletedAt) throw new NotesError('Restore notes before organizing them.');
          return note;
        });
        const ids = new Set(notes.map(note => note.id));
        if (ids.size !== notes.length) throw new NotesError('Choose each note once.');
        let folderId: string | null;
        if (data.action === 'group') {
          if (notes.length < 2) throw new NotesError('Choose at least two notes for a folder.');
          if (library.folders.length >= 500) throw new NotesError('The folder limit has been reached.');
          const name = text(data.name, 100).trim();
          if (!name) throw new NotesError('Give this folder a name.');
          const parentId = folderTarget(data.folderId, library);
          let parent = parentId; let depth = 1;
          while (parent) { depth++; parent = library.folders.find(item => item.id === parent)?.parentId || null; }
          if (depth > 32) throw new NotesError('Folders can be nested up to 32 levels.');
          const folder: NoteFolder = { id: randomUUID(), name, parentId };
          library.folders.push(folder); folderId = folder.id;
        } else if (data.action === 'move') folderId = folderTarget(data.folderId, library);
        else if (data.action !== 'reorder') throw new NotesError('Choose a valid organization action.');
        let anchor: Note | undefined;
        if (data.action === 'reorder') {
          if (typeof data.targetId !== 'string' || ids.has(data.targetId) || !['before', 'after'].includes(String(data.position))) throw new NotesError('Choose a different page to reorder around.');
          anchor = library.notes.find(note => note.id === data.targetId && !note.deletedAt);
          if (!anchor) throw new NotesError('This page no longer exists.', 404);
          if (notes.some(note => note.folderId !== anchor!.folderId) && data.folderId !== 'all') throw new NotesError('Reorder pages in the same collection.');
        }
        const base = library.noteOrder || [...library.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(note => note.id);
        const ordered = new Set(base);
        const remaining = [...base.filter(id => !ids.has(id)), ...library.notes.filter(note => !ordered.has(note.id) && !ids.has(note.id)).map(note => note.id)];
        const index = anchor ? remaining.indexOf(anchor.id) + (data.position === 'after' ? 1 : 0) : 0;
        remaining.splice(index, 0, ...notes.map(note => note.id));
        library.noteOrder = remaining;
        for (const note of notes) {
          if (data.action !== 'reorder') note.folderId = folderId!;
          note.revision++;
        }
        return library;
      });
    },
    trash(id: string, revision: unknown, restore = false) {
      return mutate(library => {
        const note = existing(library, id, revision);
        note.deletedAt = restore ? null : new Date().toISOString();
        note.updatedAt = new Date().toISOString(); note.revision += 1; return note;
      });
    },
    createFolder(value: unknown) {
      const data = object(value);
      return mutate(library => {
        if (library.folders.length >= 500) throw new NotesError('The folder limit has been reached.');
        const folder: NoteFolder = { id: randomUUID(), name: text(data.name, 100).trim(), parentId: folderTarget(data.parentId, library) };
        if (!folder.name) throw new NotesError('Give this folder a name.');
        let parent = folder.parentId; let depth = 1;
        while (parent) { depth++; parent = library.folders.find(item => item.id === parent)?.parentId || null; }
        if (depth > 32) throw new NotesError('Folders can be nested up to 32 levels.');
        library.folders.push(folder); return folder;
      });
    },
    updateFolder(id: string, value: unknown) {
      const data = object(value);
      return mutate(library => {
        const folder = library.folders.find(item => item.id === id);
        if (!folder) throw new NotesError('This folder no longer exists.', 404);
        if (data.name !== undefined) { const name = text(data.name, 100).trim(); if (!name) throw new NotesError('Give this folder a name.'); folder.name = name; }
        return folder;
      });
    },
    removeFolder(id: string) {
      return mutate(library => {
        const folder = library.folders.find(item => item.id === id);
        if (!folder) throw new NotesError('This folder no longer exists.', 404);
        for (const note of library.notes.filter(item => item.folderId === id)) { note.folderId = folder.parentId; note.revision++; }
        for (const child of library.folders.filter(item => item.parentId === id)) child.parentId = folder.parentId;
        library.folders = library.folders.filter(item => item.id !== id);
        return library;
      });
    },
  };
}
