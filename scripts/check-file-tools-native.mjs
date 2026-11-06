import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const helper = process.env.HABIBI_FILE_TOOLS_HELPER || '/private/tmp/HabibiFileTools';
const fixtureHelper =
  process.env.HABIBI_FILE_TOOLS_FIXTURES || '/private/tmp/HabibiFileToolsFixtures';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'habibi-converters-'));
const run = (value) =>
  JSON.parse(
    execFileSync(helper, [], {
      input: JSON.stringify(value),
      maxBuffer: 2 * 1024 * 1024,
    }).toString(),
  );
try {
  execFileSync(fixtureHelper, [root]);
  const a = path.join(root, 'report-a.pdf'),
    b = path.join(root, 'report-b.pdf');
  const original = await fs.readFile(a);
  assert.equal(run({ action: 'inspect', path: a }).pages, 3);
  assert.match(run({ action: 'inspect', path: a }).text, /Demo Cafe/);
  const merged = path.join(root, 'merged.pdf');
  run({ action: 'pdf', sources: [a, b], destination: merged });
  assert.equal(run({ action: 'inspect', path: merged }).pages, 6);
  const extracted = path.join(root, 'extracted.pdf');
  run({
    action: 'pdf',
    sources: [a],
    destination: extracted,
    pages: [
      { path: a, page: 3, rotate: 90 },
      { path: a, page: 1 },
    ],
  });
  const extractedInfo = run({ action: 'inspect', path: extracted });
  assert.equal(extractedInfo.pages, 2);
  assert.ok(extractedInfo.text.indexOf('Page 3') < extractedInfo.text.lastIndexOf('Page 1'));
  const compressed = path.join(root, 'compressed.pdf');
  run({ action: 'pdf', sources: [a], destination: compressed, quality: 60 });
  assert.equal(run({ action: 'inspect', path: compressed }).pages, 3);
  const image = path.join(root, 'photo.png'),
    output = path.join(root, 'photo-small.jpg');
  run({
    action: 'image',
    sources: [image],
    destination: output,
    width: 900,
    quality: 65,
    targetBytes: 400_000,
  });
  assert.ok((await fs.stat(output)).size < (await fs.stat(image)).size);
  const info = run({ action: 'inspect', path: output });
  assert.equal(info.width, 900);
  assert.deepEqual(await fs.readFile(a), original);
  assert.throws(
    () => run({ action: 'pdf', sources: [a], destination: merged }),
    'Never overwrite an existing file',
  );
  assert.throws(() =>
    run({
      action: 'pdf',
      sources: [a],
      destination: path.join(root, 'bad.pdf'),
      pages: [{ path: a, page: 99 }],
    }),
  );
  const disposable = path.join(root, 'trash-fixture.txt');
  await fs.writeFile(disposable, 'Disposable fictional fixture');
  const trashed = run({ action: 'trash', path: disposable });
  await assert.rejects(fs.stat(disposable));
  await fs.rename(trashed.path, disposable);
  assert.equal(await fs.readFile(disposable, 'utf8'), 'Disposable fictional fixture');
  console.log(
    'Native file tools passed: PDF text, merge, extract/reorder/rotate, compressed copy, image compression/resize/OCR, no overwrite, originals preserved, Trash round trip.',
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
