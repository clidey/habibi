import assert from 'node:assert/strict';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLlmService } = require('../dist/src/server/services/llm-service.js');
const { createFileToolsService } = require('../dist/src/server/services/file-tools/service.js');
const root = await promises.mkdtemp(path.join(os.tmpdir(), 'habibi-live-file-tools-'));
const model = process.env.HABIBI_TEST_MODEL || 'gpt-6-luna';
process.env.HABIBI_KEYCHAIN_HELPER ||= '/Applications/Habibi.app/Contents/MacOS/HabibiKeychain';
process.env.HABIBI_FILE_TOOLS_HELPER ||= '/private/tmp/HabibiFileTools';
const fixtureHelper =
  process.env.HABIBI_FILE_TOOLS_FIXTURES || '/private/tmp/HabibiFileToolsFixtures';
const results = [];
try {
  await promises.mkdir(path.join(root, '.habibi'));
  await promises.writeFile(
    path.join(root, '.habibi/llm-config.json'),
    JSON.stringify({ provider: 'openai', model }),
    { mode: 0o600 },
  );
  const llm = createLlmService({ root, fs, spawn });
  const state = await llm.configured();
  if (!state.configured)
    throw new Error('Configure an OpenAI key in Habibi before running live tests.');
  const service = createFileToolsService({ root, llm });
  const batch = path.join(root, 'Batch');
  await promises.mkdir(batch);
  for (let i = 1; i <= 40; i++)
    await promises.writeFile(
      path.join(batch, `scan-${i}.txt`),
      `Invoice\nVendor: Demo Cafe ${i}\nDate: 2026-11-06\nCurrency: GBP\nTotal: ${(i + 0.5).toFixed(2)}\n`,
    );
  const batchGrant = await service.grant(batch);
  const prepare = async (task, request, grants, options = {}) => {
    const result = await service.prepare({
      task,
      request,
      grants: grants.map((g) => g.id),
      allowModel: true,
      ...options,
    });
    // The fixture runner explicitly confirms preview generation; model output alone never executes it.
    if (result.plan.changes.some((change) => ['image', 'pdf', 'csv'].includes(change.kind))) {
      assert.equal(result.previews.length, 0);
      const confirmed = await service.preview(
        result.plan.id,
        result.plan.changes.map((_, index) => index),
      );
      result.previews = confirmed.previews;
    }
    results.push({
      task,
      model,
      changes: result.plan.changes.length,
      findings: result.plan.findings.length,
    });
    console.log(
      `Live ${task}: ${result.plan.changes.length} proposed changes, ${result.plan.findings.length} findings (${model})`,
    );
    return result;
  };
  const renamed = await prepare(
    'rename',
    'Rename ALL 40 receipt files using the vendor and date in their contents. Preserve .txt. Include every file exactly once.',
    [batchGrant],
    { shareContents: true },
  );
  assert.equal(renamed.plan.changes.length, 40);
  assert.ok(renamed.plan.changes.every((c) => c.kind === 'move' && /2026/.test(c.destination)));
  await service.apply(
    renamed.plan.id,
    renamed.plan.changes.map((_, i) => i),
    false,
  );
  await service.undo(renamed.plan.id);
  assert.equal((await promises.readdir(batch)).length, 40);
  const organized = await prepare(
    'organize',
    'Move all these invoice text files into an Invoices subfolder, preserving their current filenames.',
    [batchGrant],
  );
  assert.equal(organized.plan.changes.length, 40);
  assert.ok(organized.plan.changes.every((c) => c.destination.startsWith('Invoices/')));
  await service.apply(
    organized.plan.id,
    organized.plan.changes.map((_, i) => i),
    false,
  );
  await service.undo(organized.plan.id);
  const media = path.join(root, 'Media');
  execFileSync(fixtureHelper, [media]);
  const mediaGrant = await service.grant(media);
  const compressed = await prepare(
    'compress',
    'Compress photo.png to a new photo-small.jpg, width 900, JPEG quality 65. Leave PDFs unchanged.',
    [mediaGrant],
  );
  assert.equal(compressed.plan.changes.length, 1);
  assert.equal(compressed.plan.changes[0].kind, 'image');
  assert.ok(compressed.previews[0].afterBytes < compressed.previews[0].beforeBytes);
  const pdf = await prepare(
    'pdf',
    'Merge report-a.pdf then report-b.pdf into combined.pdf, retaining every page.',
    [mediaGrant],
  );
  assert.equal(pdf.plan.changes.length, 1);
  assert.equal(pdf.plan.changes[0].kind, 'pdf');
  const extracted = await prepare(
    'extract',
    'Create invoices.csv with Vendor,Date,Currency,Total. Each PDF repeats its one invoice on 3 pages: include one row per PDF, not one per page. Do not include the image.',
    [mediaGrant],
    { shareContents: true },
  );
  assert.equal(extracted.plan.changes.length, 1);
  assert.match(extracted.plan.changes[0].csv, /Demo Cafe/);
  assert.match(extracted.plan.changes[0].csv, /12.50/);
  const found = await prepare(
    'find',
    'Which document is the Demo Studio invoice for GBP 40? Explain using extracted evidence. No changes.',
    [mediaGrant],
    { shareContents: true },
  );
  assert.ok(found.plan.findings.length);
  assert.ok(
    found.plan.findings.some(
      (f) => found.plan.entries.find((e) => e.id === f.fileId).relative === 'report-b.pdf',
    ),
  );
  const storage = await prepare(
    'storage',
    'Explain which files take the most space using the actual scan sizes. Do not modify anything.',
    [mediaGrant],
  );
  assert.equal(storage.plan.changes.length, 0);
  await promises.copyFile(path.join(media, 'report-a.pdf'), path.join(media, 'report-a-copy.pdf'));
  const duplicates = await prepare(
    'duplicates',
    'Identify exact duplicates and suggest which copy to keep. Do not remove or change anything.',
    [mediaGrant],
  );
  assert.equal(duplicates.duplicates.groups.length, 1);
  assert.equal(duplicates.plan.changes.length, 0);
  const cleanup = await prepare(
    'duplicates',
    'Allow cleanup is explicitly enabled. Prepare one proposed trash change for report-a-copy.pdf for my review. Keep report-a.pdf and all other files. Do not execute it; the host will ask me to approve the preview.',
    [mediaGrant],
    { allowCleanup: true },
  );
  assert.equal(cleanup.plan.changes.length, 1);
  assert.equal(cleanup.plan.changes[0].kind, 'trash');
  await service.apply(cleanup.plan.id, [0], true);
  await assert.rejects(promises.stat(path.join(media, 'report-a-copy.pdf')));
  await service.undo(cleanup.plan.id);
  assert.ok(await promises.stat(path.join(media, 'report-a-copy.pdf')));
  const pages = await prepare(
    'pdf',
    'Create selected-pages.pdf containing report-a.pdf page 3 rotated clockwise by 90 degrees, followed by page 1. Do not include any other pages or files.',
    [mediaGrant],
  );
  assert.equal(pages.plan.changes.length, 1);
  assert.equal(pages.plan.changes[0].pages.length, 2);
  assert.equal(pages.plan.changes[0].pages[0].page, 3);
  assert.equal(pages.plan.changes[0].pages[0].rotate, 90);
  const timer = await service.daily('Prepare a 17 minute focus timer called Write proposal');
  assert.equal(timer.kind, 'timer');
  assert.equal(timer.seconds, 1020);
  const reminder = await service.daily('Remind me tomorrow at noon to pack lunch');
  assert.equal(reminder.kind, 'reminder');
  assert.match(reminder.title, /pack lunch/i);
  assert.ok(reminder.due);
  await promises.writeFile(
    '/private/tmp/habibi-file-tools-live-results.json',
    JSON.stringify({ model, results, timer, reminder, passed: true }, null, 2),
    { mode: 0o600 },
  );
  console.log(
    'Live OpenAI checks passed, including 40-file apply/undo and timer/reminder planning. Only fictional fixtures were submitted.',
  );
} finally {
  await promises.rm(root, { recursive: true, force: true });
}
