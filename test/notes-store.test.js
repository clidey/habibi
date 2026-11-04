const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createNotesStore } = require('../src/server/services/notes-store');

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'habibi-notes-test-'));
  try { await run(createNotesStore(root), root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
test('notes persist across restarts in an atomic private library with nested folders', async () => fixture(async (store, root) => {
  const parent = await store.createFolder({ name: 'Projects' });
  const child = await store.createFolder({ name: 'Demo', parentId: parent.id });
  const note = await store.create({ title: 'A plan', body: '# First idea\n\n- [ ] Test this', folderId: child.id });
  assert.equal(note.revision, 1);
  const updated = await store.update(note.id, { title: 'The plan', body: 'A revised idea.', revision: 1 });
  assert.equal(updated.revision, 2);
  const fresh = await createNotesStore(root).list();
  assert.equal(fresh.notes[0].body, 'A revised idea.');
  assert.equal(fresh.folders[1].parentId, parent.id);
  const file = path.join(root, '.habibi/notes/library.json');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal((await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp')).length, 0);
}));
test('simultaneous stale edits cannot overwrite a newer saved note', async () => fixture(async store => {
  const note = await store.create({ title: 'Concurrent', body: 'Original' });
  const results = await Promise.allSettled([
    store.update(note.id, { body: 'First editor', revision: 1 }),
    store.update(note.id, { body: 'Stale editor', revision: 1 }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal((await store.list()).notes[0].body, 'First editor');
}));
test('removing folders keeps notes and children, and Trash restores the original note', async () => fixture(async store => {
  const parent = await store.createFolder({ name: 'Parent' });
  const folder = await store.createFolder({ name: 'Folder', parentId: parent.id });
  const child = await store.createFolder({ name: 'Child', parentId: folder.id });
  const note = await store.create({ title: 'Keep me', body: 'Useful content', folderId: folder.id });
  const library = await store.removeFolder(folder.id);
  assert.equal(library.notes[0].folderId, parent.id);
  assert.equal(library.folders.find(item => item.id === child.id).parentId, parent.id);
  const deleted = await store.trash(note.id, 2);
  assert.ok(deleted.deletedAt);
  await assert.rejects(store.update(note.id, { body: 'Bad write', revision: 3 }), /Restore/);
  const restored = await store.trash(note.id, 3, true);
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.body, 'Useful content');
}));
test('invalid input and corrupt stores do not discard or overwrite user content', async () => fixture(async (store, root) => {
  const note = await store.create({ title: 'Safe', body: 'Keep this' });
  await assert.rejects(store.update(note.id, { body: 'x'.repeat(262145), revision: 1 }), /too long/);
  await assert.rejects(store.create({ folderId: '../../outside' }), /existing folder/);
  assert.equal((await store.list()).notes[0].body, 'Keep this');
  const file = path.join(root, '.habibi/notes/library.json');
  await fs.writeFile(file, 'broken library');
  await assert.rejects(store.create({ title: 'Do not reset' }), /has not been changed/);
  assert.equal(await fs.readFile(file, 'utf8'), 'broken library');
}));

test('catalog page icons survive edits and restarts alongside legacy notes', async () => fixture(async (store, root) => {
  const legacy = await store.create({ title: 'Older page', emoji: '🚀' });
  const note = await store.create({ title: 'A page', icon: 'file-text' });
  const updated = await store.update(note.id, { revision: note.revision, icon: 'calendar' });
  assert.equal(updated.icon, 'calendar');
  const reloaded = await createNotesStore(root).list();
  assert.equal(reloaded.notes.find(item => item.id === note.id).icon, 'calendar');
  assert.equal(reloaded.notes.find(item => item.id === legacy.id).emoji, '🚀');
  for (const invalid of ['../file', '<svg>', 'A'.repeat(81), null, 5]) {
    await assert.rejects(store.update(note.id, { revision: updated.revision, icon: invalid }), /valid page icon/);
  }
  assert.equal((await store.list()).notes.find(item => item.id === note.id).icon, 'calendar');
}));

test('drag organization groups and moves pages atomically, retaining content and persisted order', async () => fixture(async (store, root) => {
  const first = await store.create({ title: 'First', body: 'One' });
  const second = await store.create({ title: 'Second', body: 'Two' });
  const third = await store.create({ title: 'Third', body: 'Three' });
  const refs = (...notes) => notes.map(({ id, revision }) => ({ id, revision }));
  let library = await store.organize({ action: 'group', name: 'Project', notes: refs(first, second) });
  const folder = library.folders.find(folder => folder.name === 'Project');
  assert.ok(folder);
  assert.equal(library.notes.filter(note => note.folderId === folder.id).length, 2);
  assert.equal(library.notes.find(note => note.id === first.id).body, 'One');
  library = await store.organize({ action: 'move', folderId: folder.id, notes: refs(third) });
  assert.equal(library.notes.filter(note => note.folderId === folder.id).length, 3);
  const moved = library.notes.find(note => note.id === third.id);
  library = await store.organize({ action: 'reorder', targetId: first.id, position: 'after', notes: refs(moved) });
  assert.deepEqual(library.noteOrder, [first.id, third.id, second.id]);
  const fresh = await createNotesStore(root).list();
  assert.deepEqual(fresh.noteOrder, library.noteOrder);
  const latest = fresh.notes.find(note => note.id === first.id);
  library = await store.organize({ action: 'move', folderId: null, notes: refs(latest) });
  assert.equal(library.notes.find(note => note.id === first.id).folderId, null);
  const created = await store.create({ title: 'New page' });
  assert.equal((await store.list()).noteOrder[0], created.id);
}));

test('invalid or stale drag groups leave every page and folder unchanged', async () => fixture(async store => {
  const first = await store.create({ title: 'First' });
  const second = await store.create({ title: 'Second' });
  await store.update(second.id, { body: 'A newer edit', revision: second.revision });
  const before = await store.list();
  await assert.rejects(store.organize({ action: 'group', name: 'Rejected', notes: [{ id: first.id, revision: 1 }, { id: second.id, revision: 1 }] }), /changed elsewhere/);
  assert.deepEqual(await store.list(), before);
  await assert.rejects(store.organize({ action: 'move', folderId: 'missing', notes: [{ id: first.id, revision: 1 }] }), /existing folder/);
  await assert.rejects(store.organize({ action: 'group', name: 'Duplicate', notes: [{ id: first.id, revision: 1 }, { id: first.id, revision: 1 }] }), /each note once/);
  await assert.rejects(store.organize({ action: 'reorder', targetId: first.id, position: 'before', notes: [{ id: first.id, revision: 1 }] }), /different page/);
  assert.deepEqual(await store.list(), before);
}));
