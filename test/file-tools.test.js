const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFileToolsService } = require('../src/server/services/file-tools/service');
const { validateFileProposal } = require('../src/server/services/file-tools/planner');
const { normalizeDailyPlan } = require('../src/server/services/file-tools/daily-plan');
const { createApprovalService } = require('../src/core/approval-service');
const { createFileToolsRouter } = require('../src/server/services/file-tools/router');
const { Readable } = require('node:stream');
async function fixture(t, answer) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'habibi-file-tools-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'Documents');
  await fs.mkdir(folder);
  await fs.writeFile(
    path.join(folder, 'scan.txt'),
    'Vendor: Demo Cafe\nDate: 2026-11-06\nTotal: GBP 12.50',
  );
  const calls = [];
  const llm = {
    async complete(input) {
      calls.push(input);
      const evidence = JSON.parse(input.messages[0].text);
      return {
        ok: true,
        provider: 'fake',
        model: 'fixture',
        text: JSON.stringify(answer(evidence)),
      };
    },
  };
  const nativeCalls = [];
  const native = async (value) => {
    nativeCalls.push(value.action);
    if (value.action === 'trash') {
      const target = path.join(root, 'Trash', path.basename(value.path));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(value.path, target);
      return { ok: true, path: target };
    }
    await fs.writeFile(value.destination, 'converted');
    return { ok: true };
  };
  const service = createFileToolsService({ root, llm, native });
  const grant = await service.grant(folder);
  return { root, folder, service, grant, calls, nativeCalls };
}
const rename = (evidence) => ({
  summary: 'Rename receipt using supplied evidence.',
  changes: [
    {
      kind: 'move',
      sources: [evidence.files[0].id],
      destination: '2026-11-06-demo-cafe.txt',
      reason: 'Vendor/date from receipt',
    },
  ],
  findings: [],
});
test('AI file plans are previews until applied, share contents only explicitly, and undo safely', async (t) => {
  const f = await fixture(t, rename);
  const result = await f.service.prepare({
    grants: [f.grant.id],
    task: 'rename',
    request: 'Rename this receipt',
    allowModel: true,
  });
  assert.ok(await fs.stat(path.join(f.folder, 'scan.txt')));
  assert.equal(JSON.parse(f.calls[0].messages[0].text).files[0].excerpt, undefined);
  const output = await f.service.apply(result.plan.id, [0], false);
  assert.equal(path.basename(output.outputs[0]), '2026-11-06-demo-cafe.txt');
  await assert.rejects(fs.stat(path.join(f.folder, 'scan.txt')));
  await f.service.undo(result.plan.id);
  assert.ok(await fs.stat(path.join(f.folder, 'scan.txt')));
  const contentPlan = await f.service.prepare({
    grants: [f.grant.id],
    task: 'rename',
    request: 'Rename using contents',
    allowModel: true,
    shareContents: true,
  });
  assert.match(JSON.parse(f.calls[1].messages[0].text).files[0].excerpt, /Demo Cafe/);
  await f.service.apply(contentPlan.plan.id, [0], false);
  await fs.appendFile(path.join(f.folder, '2026-11-06-demo-cafe.txt'), 'An edit');
  await assert.rejects(f.service.undo(contentPlan.plan.id), /changed/);
});
test('file tools reject private paths, symlinks, fabricated IDs, traversal, overwrites, and cleanup without opt-in', async (t) => {
  const f = await fixture(t, (evidence) => ({
    summary: 'Unsafe',
    changes: [{ kind: 'move', sources: [evidence.files[0].id], destination: '../escape.txt' }],
    findings: [],
  }));
  await assert.rejects(f.service.grant(path.join(f.root, '.ssh/id_rsa')), /private/);
  const alias = path.join(f.root, 'alias');
  await fs.symlink(f.folder, alias);
  await assert.rejects(f.service.grant(alias), /symbolic/);
  await assert.rejects(
    f.service.prepare({
      grants: [f.grant.id],
      task: 'rename',
      request: 'Rename',
      allowModel: true,
    }),
    /relative/,
  );
  const entry = (await f.service.inspect([f.grant.id])).entries[0];
  const proposal = (change) => ({ summary: '', changes: [change], findings: [] });
  assert.throws(
    () =>
      validateFileProposal(
        proposal({ kind: 'move', sources: ['fabricated'], destination: 'new.txt' }),
        [entry],
        'rename',
        false,
      ),
    /outside/,
  );
  assert.throws(
    () =>
      validateFileProposal(
        proposal({ kind: 'trash', sources: [entry.id] }),
        [entry],
        'storage',
        false,
      ),
    /Removal is off/,
  );
  assert.throws(
    () =>
      validateFileProposal(
        proposal({ kind: 'move', sources: [entry.id], destination: 'new.exe' }),
        [entry],
        'rename',
        false,
      ),
    /extension/,
  );
  assert.throws(
    () =>
      validateFileProposal(
        proposal({ kind: 'shell', sources: [entry.id] }),
        [entry],
        'rename',
        false,
      ),
    /unsupported/,
  );
});
test('file previews cannot execute stale files or write through substituted folders', async (t) => {
  const f = await fixture(t, rename);
  const first = await f.service.prepare({
    grants: [f.grant.id],
    task: 'rename',
    request: 'Rename',
    allowModel: true,
  });
  await fs.appendFile(path.join(f.folder, 'scan.txt'), 'Changed');
  await assert.rejects(f.service.apply(first.plan.id, [0], false), /changed/);
  const second = await f.service.prepare({
    grants: [f.grant.id],
    task: 'rename',
    request: 'Rename',
    allowModel: true,
  });
  await fs.writeFile(path.join(f.folder, '2026-11-06-demo-cafe.txt'), 'Existing');
  await assert.rejects(f.service.apply(second.plan.id, [0], false), /exists/);
  assert.equal(
    await fs.readFile(path.join(f.folder, '2026-11-06-demo-cafe.txt'), 'utf8'),
    'Existing',
  );
});
test('duplicate scan proves identical bytes and cleanup preserves one original copy', async (t) => {
  const f = await fixture(t, (evidence) => ({
    summary: 'Two identical copies',
    changes: evidence.files.map((file) => ({
      kind: 'trash',
      sources: [file.id],
      reason: 'duplicate',
    })),
    findings: [],
  }));
  await fs.copyFile(path.join(f.folder, 'scan.txt'), path.join(f.folder, 'copy.txt'));
  const local = await f.service.prepare({
    grants: [f.grant.id],
    task: 'duplicates',
    request: 'Find duplicates',
  });
  assert.equal(local.duplicates.groups.length, 1);
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    f.service.prepare({
      grants: [f.grant.id],
      task: 'duplicates',
      request: 'Remove duplicates',
      allowModel: true,
      allowCleanup: true,
    }),
    /retain/,
  );
});
test('bounded conversions create new outputs, preserve originals, and undo retains generated copies', async (t) => {
  const f = await fixture(t, (evidence) => ({
    summary: 'Extract receipt',
    changes: [
      {
        kind: 'csv',
        sources: [evidence.files[0].id],
        destination: 'expenses.csv',
        csv: 'Vendor,Total\nDemo Cafe,12.50\n=HYPERLINK("https://example.test"),1',
        reason: 'Receipt values',
      },
    ],
    findings: [],
  }));
  const result = await f.service.prepare({
    grants: [f.grant.id],
    task: 'extract',
    request: 'Extract expenses',
    allowModel: true,
    shareContents: true,
  });
  assert.equal(result.previews.length, 0, 'Planning must not generate converted outputs');
  const confirmedPreview = await f.service.preview(result.plan.id, [0]);
  assert.equal(confirmedPreview.previews.length, 1);
  assert.match(result.plan.changes[0].csv, /'=HYPERLINK/);
  await assert.rejects(fs.stat(path.join(f.folder, 'expenses.csv')));
  await f.service.apply(result.plan.id, [0], false);
  assert.ok(await fs.stat(path.join(f.folder, 'scan.txt')));
  await f.service.undo(result.plan.id);
  await assert.rejects(fs.stat(path.join(f.folder, 'expenses.csv')));
  assert.equal((await fs.readdir(path.join(f.root, '.habibi/file-tools/undo'))).length, 1);
});
test('file-tool HTTP writes consume approvals bound to the exact selection and cleanup flag', async (t) => {
  const f = await fixture(t, rename);
  const prepared = await f.service.prepare({
    grants: [f.grant.id],
    task: 'rename',
    request: 'Rename',
    allowModel: true,
  });
  const approvals = createApprovalService();
  const route = createFileToolsRouter(f.service, approvals);
  async function post(body) {
    const request = Readable.from([JSON.stringify(body)]);
    request.method = 'POST';
    request.headers = { 'content-type': 'application/json' };
    let result;
    const response = {
      writeHead() {},
      end(value) {
        result = JSON.parse(value);
      },
    };
    await route(request, response, new URL('http://localhost/api/file-tools/apply'));
    return result;
  }
  const payload = { planId: prepared.plan.id, selected: [0], cleanupAcknowledged: false };
  assert.equal((await post(payload)).ok, false);
  const token = approvals.issue('file-tools.apply', payload).token;
  assert.equal(
    (await post({ ...payload, cleanupAcknowledged: true, approvalToken: token })).ok,
    false,
  );
  assert.equal(
    (await post({ ...payload, approvalToken: token })).ok,
    false,
    'Mismatch spends the token',
  );
  const valid = approvals.issue('file-tools.apply', payload).token;
  assert.equal((await post({ ...payload, approvalToken: valid })).ok, true);
  assert.equal((await post({ ...payload, approvalToken: valid })).ok, false);
});
test('daily AI proposals validate durations, dates and bounded actions without executing', () => {
  assert.equal(normalizeDailyPlan({ kind: 'timer', action: 'start', seconds: 1500 }).seconds, 1500);
  assert.throws(
    () => normalizeDailyPlan({ kind: 'timer', action: 'start', seconds: -1 }),
    /between/,
  );
  assert.throws(
    () =>
      normalizeDailyPlan({ kind: 'reminder', action: 'create', title: 'Task', due: 'tomorrow' }),
    /date/,
  );
  assert.throws(() => normalizeDailyPlan({ kind: 'shell', command: 'rm' }), /choose/);
  assert.equal(
    normalizeDailyPlan({
      kind: 'reminder',
      action: 'create',
      title: 'Pack lunch',
      due: '2026-11-07T12:00:00+05:30',
    }).title,
    'Pack lunch',
  );
});

test('compression is not processed by a model plan; previews and writes each require exact fresh HTTP approval', async (t) => {
  const f = await fixture(t, (evidence) => ({
    summary: 'Compress a copy',
    approved: true,
    execute: true,
    approvalToken: 'model-cannot-approve',
    changes: [
      {
        kind: 'image',
        sources: [evidence.files[0].id],
        destination: 'compressed.jpg',
        width: 900,
        quality: 65,
        reason: 'Smaller copy',
      },
      {
        kind: 'image',
        sources: [evidence.files[0].id],
        destination: 'other.jpg',
        reason: 'Unselected copy',
      },
    ],
    findings: [],
  }));
  const result = await f.service.prepare({
    grants: [f.grant.id],
    task: 'compress',
    request: 'Compress for review',
    allowModel: true,
  });
  assert.deepEqual(f.nativeCalls, []);
  assert.deepEqual(result.previews, []);
  await assert.rejects(fs.stat(path.join(f.root, '.habibi/file-tools/previews')));
  const approvals = createApprovalService();
  const route = createFileToolsRouter(f.service, approvals);
  async function post(action, body) {
    const request = Readable.from([JSON.stringify(body)]);
    request.method = 'POST';
    request.headers = { 'content-type': 'application/json' };
    let result;
    const response = {
      writeHead() {},
      end(value) {
        result = JSON.parse(value);
      },
    };
    await route(request, response, new URL('http://localhost/api/file-tools/' + action));
    return result;
  }
  const payload = { planId: result.plan.id, selected: [0] };
  assert.equal((await post('preview', payload)).ok, false);
  assert.equal(
    (await post('preview', { ...payload, approvalToken: 'model-cannot-approve', approved: true }))
      .ok,
    false,
  );
  const wrongSelection = approvals.issue('file-tools.preview', payload).token;
  assert.equal(
    (await post('preview', { ...payload, selected: [1], approvalToken: wrongSelection })).ok,
    false,
  );
  assert.equal((await post('preview', { ...payload, approvalToken: wrongSelection })).ok, false);
  assert.deepEqual(f.nativeCalls, []);
  const previewToken = approvals.issue('file-tools.preview', payload).token;
  const preview = await post('preview', { ...payload, approvalToken: previewToken });
  assert.equal(preview.ok, true);
  assert.equal(preview.previews.length, 1);
  assert.deepEqual(f.nativeCalls, ['image']);
  await assert.rejects(fs.stat(path.join(f.folder, 'compressed.jpg')));
  assert.equal((await post('preview', { ...payload, approvalToken: previewToken })).ok, false);
  const applyPayload = { ...payload, cleanupAcknowledged: false };
  assert.equal((await post('apply', applyPayload)).ok, false);
  assert.equal((await post('apply', { ...applyPayload, approvalToken: previewToken })).ok, false);
  await assert.rejects(fs.stat(path.join(f.folder, 'compressed.jpg')));
  const applyToken = approvals.issue('file-tools.apply', applyPayload).token;
  assert.equal((await post('apply', { ...applyPayload, approvalToken: applyToken })).ok, true);
  assert.equal(await fs.readFile(path.join(f.folder, 'compressed.jpg'), 'utf8'), 'converted');
  await assert.rejects(fs.stat(path.join(f.folder, 'other.jpg')));
  assert.deepEqual(f.nativeCalls, ['image'], 'Unselected conversions must not run');
  assert.equal((await post('apply', { ...applyPayload, approvalToken: applyToken })).ok, false);
  assert.equal((await post('undo', { planId: result.plan.id })).ok, false);
  const undoToken = approvals.issue('file-tools.undo', { planId: result.plan.id }).token;
  assert.equal((await post('undo', { planId: result.plan.id, approvalToken: undoToken })).ok, true);
});
