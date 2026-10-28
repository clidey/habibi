const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalSearchIndex } = require('../src/server/services/local-search-index');

async function fixture(run, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'habibi-search-'));
  const index = createLocalSearchIndex({ roots: [root], watch: false, ...options });
  try { await run(root, index); } finally { index.close(); await fs.rm(root, { recursive: true, force: true }); }
}

test('filename indexing is recursive, Unicode aware, and excludes hidden/generated/symlink trees', async () => {
  await fixture(async (root, index) => {
    for (const dir of ['notes', 'node_modules', '.secrets', 'Example.app']) {
      await fs.mkdir(path.join(root, dir));
      await fs.writeFile(path.join(root, dir, 'Café design.md'), 'content is not indexed');
    }
    await fs.symlink(path.join(root, 'notes'), path.join(root, 'alias'));
    const results = await index.search('cafe design');
    assert.equal(results.length, 1);
    assert.equal(results[0].path, path.join(root, 'notes', 'Café design.md'));
    assert.deepEqual(await index.search('content is not indexed'), []);
    assert.equal(index.status().watchers, 0);
  });
});

test('concurrent cold queries share one index and ranked results retain duplicate filenames at different paths', async () => {
  await fixture(async (root, index) => {
    await fs.mkdir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'brief.md'), '');
    await fs.writeFile(path.join(root, 'nested', 'brief.md'), '');
    await fs.writeFile(path.join(root, 'brief-final.md'), '');
    const results = await Promise.all([index.search('brief'), index.search('brief')]);
    assert.equal(results[0].length, 3);
    assert.equal(results[0][0].name, 'brief.md');
    assert.deepEqual(results[0], results[1]);
    assert.equal(index.status().indexed, 4);
  });
});

test('entry and directory budgets are enforced, with explicit truncation and refresh', async () => {
  await fixture(async (root, index) => {
    for (let i = 0; i < 20; i++) await fs.writeFile(path.join(root, `file-${i}.txt`), '');
    await index.ready();
    assert.equal(index.status().indexed, 5);
    assert.equal(index.status().truncated, true);
    await fs.rm(path.join(root, (await index.search('file'))[0].name));
    await index.refresh();
    assert.equal(index.status().indexed, 5);
    assert.ok((await index.search('file')).every((item) => item.path.startsWith(root + path.sep)));
  }, { maxEntries: 5 });
});

test('warm queries perform no filesystem reads and preserve deterministic ranking', async () => {
  await fixture(async (root, index) => {
    await fs.writeFile(path.join(root, 'invoice.pdf'), '');
    await index.ready();
    await fs.rm(path.join(root, 'invoice.pdf'));
    // The disabled watcher deliberately leaves a snapshot. Searching never stats or rescans it.
    assert.equal((await index.search('invoice'))[0].name, 'invoice.pdf');
    await index.refresh();
    assert.deepEqual(await index.search('invoice'), []);
  });
});

test('filesystem notifications add, rename, and remove files without a periodic scanner', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'habibi-watch-'));
  const events = [];
  const index = createLocalSearchIndex({ roots: [root], watcherFactory(directory, options, listener) {
    return watch(directory, options, (event, filename) => {
      if (events.length < 30) events.push([event, filename === null ? null : String(filename)]);
      listener(event, filename);
    });
  } });
  const eventually = async (query, count) => {
    // FSEvents delivery is deferred on busy macOS CI hosts. This is a test-only
    // deadline; the production index still updates exclusively from notifications.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if ((await index.search(query)).length === count) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await index.search(query)).length, count, `Notifications received: ${JSON.stringify(events)}`);
  };
  try {
    await index.ready();
    if (!index.status().watchers) return t.skip('recursive filesystem notifications unavailable');
    await fs.mkdir(path.join(root, 'new-directory'));
    await fs.writeFile(path.join(root, 'new-directory', 'alpha.txt'), '');
    await eventually('alpha', 1);
    await fs.rename(path.join(root, 'new-directory', 'alpha.txt'), path.join(root, 'new-directory', 'beta.txt'));
    await eventually('beta', 1);
    assert.deepEqual(await index.search('alpha'), []);
    await fs.rm(path.join(root, 'new-directory'), { recursive: true });
    await eventually('beta', 0);
  } finally { index.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('coalesced notifications without filenames reconcile newly added and removed directory trees', async () => {
  let notify;
  await fixture(async (root, index) => {
    const eventually = async count => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if ((await index.search('coalesced')).length === count) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal((await index.search('coalesced')).length, count);
    };
    const directory = path.join(root, 'new-directory');
    await fs.mkdir(directory);
    await index.ready();
    await fs.writeFile(path.join(directory, 'coalesced.txt'), '');
    notify('rename', null);
    await eventually(1);
    await fs.rm(directory, { recursive: true });
    notify('rename', null);
    await eventually(0);
  }, {
    watch: true,
    watcherFactory(_root, options, listener) {
      assert.equal(options.recursive, true);
      assert.equal(options.persistent, false);
      notify = listener;
      return { on() {}, close() {} };
    },
  });
});
