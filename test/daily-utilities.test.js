const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRecentFiles } = require('../src/server/services/recent-files');
const { readMailAttachments } = require('../src/server/services/mail-attachments');
const { dailyIntent } = require('../src/core/daily-intent');

test('recent files deduplicate, pin, survive reload, and reject paths outside home or private app data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'habibi-recents-test-'));
  try {
    const home = path.join(root, 'home');
    await fs.mkdir(home);
    const doc = path.join(home, 'plan.txt');
    await fs.writeFile(doc, 'Fictional document');
    const outside = path.join(root, 'outside.txt');
    await fs.writeFile(outside, 'Outside');
    await fs.symlink(outside, path.join(home, 'escape.txt'));
    const store = createRecentFiles(root, home);
    await Promise.all([store.record(doc), store.record(doc)]);
    assert.equal((await store.list()).length, 1);
    const item = (await store.list())[0];
    await store.update(item.id, true);
    assert.equal((await createRecentFiles(root, home).list())[0].pinned, true);
    await store.record(path.join(home, 'escape.txt'));
    assert.equal((await store.list()).length, 1);
    await fs.mkdir(path.join(home, '.habibi'));
    await fs.writeFile(path.join(home, '.habibi', 'token'), 'not a secret');
    await store.record(path.join(home, '.habibi', 'token'));
    assert.equal((await store.list()).length, 1);
    await fs.unlink(doc);
    assert.equal((await store.list())[0].available, false);
    const mode = (await fs.stat(path.join(root, '.habibi/recent/files.json'))).mode & 0o777;
    assert.equal(mode, 0o600);
    await store.remove();
    assert.deepEqual(await store.list(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('mail attachment snapshots are bounded, named safely, and cannot follow an escaping symlink', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'habibi-mail-files-test-'));
  try {
    const home = path.join(root, 'home');
    await fs.mkdir(home);
    const file = path.join(home, 'plan.txt');
    await fs.writeFile(file, 'A fictional plan');
    const result = await readMailAttachments([{ path: file, name: 'plan.txt' }], home);
    assert.equal(result[0].content.toString(), 'A fictional plan');
    const outside = path.join(root, 'outside');
    await fs.writeFile(outside, 'outside');
    await fs.symlink(outside, path.join(home, 'escape'));
    await assert.rejects(
      readMailAttachments([{ path: path.join(home, 'escape'), name: 'escape' }], home),
    );
    await assert.rejects(readMailAttachments([{ path: file, name: '../bad' }], home));
    await assert.rejects(
      readMailAttachments(Array(6).fill({ path: file, name: 'plan.txt' }), home),
    );
    const large = path.join(home, 'large');
    const handle = await fs.open(large, 'w');
    await handle.truncate(8 * 1024 * 1024 + 1);
    await handle.close();
    await assert.rejects(readMailAttachments([{ path: large, name: 'large' }], home));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('daily commands route locally without confusing ordinary prose with actions', () => {
  assert.equal(dailyIntent('Tomorrow remind me at 12pm to pack lunch').name, 'reminders');
  assert.deepEqual(dailyIntent('start a 25 minute focus timer'), { name: 'focus', minutes: 25 });
  assert.equal(dailyIntent('show my recent files').name, 'recents');
  assert.equal(dailyIntent('What is a focus timer?'), null);
});

test('reminder drafts separate task text from relative dates, noon, and times', async () => {
  const { reminderDraft } = await import('../src/client/features/daily/reminder-draft.js');
  const now = new Date(2026, 10, 3, 10, 0);
  const draft = reminderDraft('Tomorrow remind me at 12pm to pack lunch', now);
  assert.equal(draft.title, 'pack lunch');
  assert.equal(draft.due, '2026-11-04T12:00');
  assert.equal(reminderDraft('remind me to call Sam in 30 minutes', now).due, '2026-11-03T10:30');
  assert.equal(reminderDraft('remind me to buy milk', now).due, '');
  assert.equal(reminderDraft('remind me tomorrow at 99pm to call', now).due, '');
});
