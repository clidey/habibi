import type { IncomingMessage, ServerResponse } from 'node:http';
import { createNotesStore, NotesError } from './notes-store';
import { notePreview } from '../../core/note-preview.js';

function reply(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new NotesError('Use a JSON request.', 415);
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += buffer.length;
    if (length > 1048576) throw new NotesError('This note is too large.', 413);
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new NotesError('Invalid note data.'); }
}

export function createNotesRouter(root: string) {
  const store = createNotesStore(root);
  return async function handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/api/notes' && !url.pathname.startsWith('/api/notes/')) return false;
    try {
      const parts = url.pathname.split('/').filter(Boolean).slice(2);
      const method = request.method;
      if (parts.length === 1 && parts[0] === 'search' && method === 'GET') {
        const query = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 200);
        const library = await store.list();
        const { lexer } = await import('marked');
        const notes = query.length < 2 ? [] : library.notes.filter(note => !note.deletedAt && `${note.title} ${note.body}`.toLowerCase().includes(query)).sort((a, b) => Number(b.title.toLowerCase().includes(query)) - Number(a.title.toLowerCase().includes(query)) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6).map(note => ({ id: note.id, title: note.title, emoji: note.emoji, icon: note.icon, preview: notePreview(note, lexer), updatedAt: note.updatedAt }));
        reply(response, { ok: true, notes });
      }
      else if (parts.length === 1 && parts[0] === 'organize' && method === 'POST') reply(response, { ok: true, ...(await store.organize(await body(request))) });
      else if (!parts.length && method === 'GET') reply(response, { ok: true, ...(await store.list()) });
      else if (!parts.length && method === 'POST') reply(response, { ok: true, note: await store.create(await body(request)) });
      else if (parts[0] === 'folders') {
        if (parts.length === 1 && method === 'POST') reply(response, { ok: true, folder: await store.createFolder(await body(request)) });
        else if (parts.length === 2 && method === 'PATCH') reply(response, { ok: true, folder: await store.updateFolder(parts[1]!, await body(request)) });
        else if (parts.length === 2 && method === 'DELETE') reply(response, { ok: true, ...(await store.removeFolder(parts[1]!)) });
        else throw new NotesError('Notes endpoint not found.', 404);
      } else if (parts.length === 1 && method === 'PATCH') reply(response, { ok: true, note: await store.update(parts[0]!, await body(request)) });
      else if (parts.length === 1 && method === 'DELETE') { const data = await body(request); reply(response, { ok: true, note: await store.trash(parts[0]!, data.revision) }); }
      else if (parts.length === 2 && parts[1] === 'restore' && method === 'POST') { const data = await body(request); reply(response, { ok: true, note: await store.trash(parts[0]!, data.revision, true) }); }
      else throw new NotesError('Notes endpoint not found.', 404);
    } catch (error) {
      reply(response, { ok: false, error: error instanceof NotesError ? error.message : 'Could not access your local notes.', code: error instanceof NotesError && error.status === 409 ? 'conflict' : 'notes_error' }, error instanceof NotesError ? error.status : 500);
    }
    return true;
  };
}
