const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<main></main>', { url: 'http://127.0.0.1:4173/' });
global.window = dom.window; global.document = dom.window.document; global.localStorage = dom.window.localStorage;
test.after(() => dom.window.close());
const id = '12345678-1234-4234-8234-123456789012';

test('Markdown renders GFM safely with readable wiki links and no automatic image or HTML execution', async () => {
  const { renderNoteMarkdown } = await import('../src/client/features/notes/notes-markdown.js');
  const target = document.querySelector('main');
  const source = '# Heading\n\n**Bold**, *italic*, ~~gone~~ and `code`.\n\n- [x] Done\n- [ ] Later\n\n| Name | Value |\n| --- | --- |\n| One | Two |\n\n```js\nconst answer = 42;\n```\n\n[[Another note]]\n\n[unsafe](javascript:alert(1))\n\n![tracker](https://example.com/pixel.png)\n\n<img src=x onerror=alert(1)><script>alert(1)</script>';
  renderNoteMarkdown(target, source, [{ id, title: 'Another note' }]);
  assert.equal(target.querySelector('h1').textContent, 'Heading');
  assert.equal(target.querySelectorAll('table').length, 1);
  assert.equal(target.querySelectorAll('input[type=checkbox]').length, 2);
  assert.match(target.querySelector('pre code').textContent, /answer/);
  assert.equal(target.querySelector('a.notes-wikilink').getAttribute('href'), `habibi://note/${id}`);
  assert.equal(target.querySelector('img,script,[onerror],a[href^="javascript:"]'), null);
  assert.ok(target.querySelector('[data-note-image]'));
});
test('reference indexing ignores code and preserves stable note IDs through renames', async () => {
  const { noteReferences } = await import('../src/client/features/notes/notes-markdown.js');
  const { parseNoteReference, noteLink } = await import('../src/client/features/notes/notes-links.js');
  const target = { id, title: 'Original' };
  const note = { id: 'different', body: `${noteLink(target)}\n\n\`[[Not a link]]\`\n\n\`\`\`\n[[Neither is this]]\n\`\`\`` };
  const refs = noteReferences(note, [{ ...target, title: 'Renamed' }]);
  assert.equal(refs.length, 1); assert.equal(refs[0].id, id);
  assert.equal(parseNoteReference('javascript:alert(1)'), null);
  assert.equal(parseNoteReference('https://user:pass@example.com'), null);
  assert.equal(parseNoteReference('habibi://whatsapp/not-a-chat'), null);
  assert.equal(parseNoteReference('habibi://workspace/terminal'), null);
});
test('autosave serializes in-flight edits and retains drafts when the backend reports a conflict', async () => {
  const { createNotesSession } = await import('../src/client/features/notes/notes-session.js');
  localStorage.clear();
  let saved = { id, title: 'Note', body: 'Old', emoji: '📝', folderId: null, revision: 1, updatedAt: '2026-11-02T00:00:00Z' };
  let release; let first = true; let conflict = false; const writes = [];
  global.fetch = async (url, options) => {
    if (options.method === 'GET') return { json: async () => ({ ok: true, notes: [saved], folders: [] }) };
    const value = JSON.parse(options.body); writes.push(value);
    if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
    if (conflict) return { json: async () => ({ ok: false, error: 'Changed elsewhere', code: 'conflict' }) };
    assert.equal(value.revision, saved.revision);
    saved = { ...saved, ...value, revision: saved.revision + 1 };
    return { json: async () => ({ ok: true, note: { ...saved } }) };
  };
  const session = createNotesSession({ onChange() {}, onStatus() {} });
  await session.load(); session.edit(id, { body: 'First' }); const writing = session.flush(id);
  session.edit(id, { body: 'Second' }); release(); await writing;
  assert.equal(saved.body, 'Second'); assert.equal(writes.length, 2); assert.equal(session.getStatus().dirty, 0);
  conflict = true; session.edit(id, { body: 'Keep my draft' });
  await assert.rejects(session.flushAll(), /Changed elsewhere/);
  assert.match(localStorage.getItem('habibi.notes.drafts.v1'), /Keep my draft/);
  assert.equal(session.getStatus().error.code, 'conflict');
});

test('a draft for a trashed note is recovered as a new note without changing the original', async () => {
  const { createNotesSession } = await import('../src/client/features/notes/notes-session.js');
  localStorage.setItem('habibi.notes.drafts.v1', JSON.stringify([{ id, revision: 1, title: 'Original title', patch: { body: 'My unsaved thoughts' } }]));
  const deleted = { id, title: 'Original title', body: 'Earlier content', emoji: '📝', folderId: null, deletedAt: '2026-11-02T00:00:00Z', revision: 2 };
  global.fetch = async (url, options) => ({ json: async () => options.method === 'GET' ? { ok: true, notes: [deleted], folders: [] } : { ok: true, note: { ...JSON.parse(options.body), id: 'new-id', revision: 1, deletedAt: null } } });
  const session = createNotesSession({ onChange() {}, onStatus() {} });
  await session.load();
  assert.equal(session.library.notes.length, 2);
  assert.equal(session.library.notes[0].title, 'Recovered: Original title');
  assert.equal(session.library.notes[0].body, 'My unsaved thoughts');
  assert.equal(deleted.body, 'Earlier content');
  assert.ok(deleted.deletedAt);
  assert.equal(localStorage.getItem('habibi.notes.drafts.v1'), '[]');
});

test('note previews summarize tables without exposing cell contents or Markdown separators', async () => {
  const { notePreview } = await import('../src/client/features/notes/note-preview.js');
  const table = '| Private name | Amount |\n| :--- | ---: |\n| Internal value | 99 |';
  assert.equal(notePreview({ body: table }), 'Table');
  assert.equal(notePreview({ body: `A short introduction\n\n${table}` }), 'A short introduction · Table');
  assert.equal(notePreview({ body: '**Plan** with [the team](https://example.com)\n\n- First task' }), 'Plan with the team · First task');
  assert.equal(notePreview({ body: '' }), 'Empty note');
});

test('organizing flushes drafts before moving and retains the open page object', async () => {
  const { createNotesSession } = await import('../src/client/features/notes/notes-session.js');
  localStorage.clear();
  let saved = { id, title: 'Draft', body: 'Before', folderId: null, revision: 1 };
  const requests = [];
  global.fetch = async (url, options) => ({ json: async () => {
    requests.push([url, options.method]);
    if (options.method === 'GET') return { ok: true, notes: [{ ...saved }], folders: [] };
    const value = JSON.parse(options.body);
    if (options.method === 'PATCH') { saved = { ...saved, ...value, revision: 2 }; return { ok: true, note: { ...saved } }; }
    assert.equal(saved.body, 'My unsaved writing');
    assert.deepEqual(value.notes, [{ id, revision: 2 }]);
    saved = { ...saved, revision: 3 };
    return { ok: true, notes: [{ ...saved }], folders: [], noteOrder: [id] };
  } });
  const session = createNotesSession({ onChange() {}, onStatus() {} });
  await session.load();
  const open = session.library.notes[0];
  session.edit(id, { body: 'My unsaved writing' });
  await session.organize([id], { action: 'move', folderId: null });
  assert.deepEqual(requests.map(([, method]) => method), ['GET', 'PATCH', 'POST']);
  assert.equal(session.library.notes[0], open);
  assert.equal(open.body, 'My unsaved writing');
  assert.equal(open.revision, 3);
  assert.equal(session.getStatus().dirty, 0);
});
