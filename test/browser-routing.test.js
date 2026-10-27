const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { browserUrl, browserCommand } = require('../src/core/browser-url');
const { createBrowserService } = require('../src/server/services/browser-service');
const { createApprovalService } = require('../src/core/approval-service');

test('explicit website commands normalize domains without misrouting files or prose', () => {
  for (const command of ['open clidey.com', 'visit clidey.com', 'go to clidey.com', 'clidey.com', 'https://clidey.com'])
    assert.equal(browserCommand(command), 'https://clidey.com/');
  assert.equal(browserCommand('open clidey.com/docs?q=hello%20world#intro'), 'https://clidey.com/docs?q=hello%20world#intro');
  assert.equal(browserCommand('open http://localhost:3000'), 'http://localhost:3000/');
  for (const command of ['project.md', 'open report.pdf', 'open ./clidey.com', 'explain clidey.com', 'open javascript:alert(1)', 'file:///tmp/test', 'open https://user:password@clidey.com', 'open https://clidey.com\nhttps://other.test', 'open https://clidey.com\\evil'])
    assert.equal(browserCommand(command), null, command);
  for (const url of ['clidey.com', 'javascript:alert(1)', 'file:///tmp/test', 'https://user:password@clidey.com', null, {}, 'https://example.test/' + 'a'.repeat(4096)])
    assert.equal(browserUrl(url), null);
});

test('browser opening requires a fresh approval bound to the exact normalized destination', async () => {
  const approvals = createApprovalService();
  const calls = [];
  const service = createBrowserService({ approvals, spawn: (...args) => {
    calls.push(args);
    const task = new EventEmitter();
    queueMicrotask(() => task.emit('close', 0));
    return task;
  } });
  const url = 'https://clidey.com/';
  assert.equal((await service.open(url)).ok, false);
  const wrong = approvals.issue('browser.open', { url: 'https://other.test/' });
  assert.equal((await service.open(url, wrong.token)).ok, false);
  assert.equal((await service.open('https://other.test/', wrong.token)).ok, false);
  const approved = approvals.issue('browser.open', { url });
  assert.deepEqual(await service.open(url, approved.token), { ok: true });
  assert.equal((await service.open(url, approved.token)).ok, false);
  assert.deepEqual(calls, [['open', [url], { stdio: 'ignore' }]]);
  assert.equal((await service.open('javascript:alert(1)', approvals.issue('browser.open', { url: 'javascript:alert(1)' }).token)).ok, false);
  assert.equal(calls.length, 1);
});

test('browser launch failures are truthful and hide raw process errors', async () => {
  for (const failure of ['throw', 'error', 'close']) {
    const approvals = createApprovalService();
    const service = createBrowserService({ approvals, spawn: () => {
      if (failure === 'throw') throw new Error('/private/raw/process-error');
      const task = new EventEmitter();
      queueMicrotask(() => task.emit(failure === 'error' ? 'error' : 'close', failure === 'error' ? new Error('/private/raw/process-error') : 1));
      return task;
    } });
    const url = 'https://clidey.com/';
    const result = await service.open(url, approvals.issue('browser.open', { url }).token);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'The website could not be opened.');
  }
});

test('model-routed website actions cannot invent or change a user-supplied destination', () => {
  const { requestedBrowserUrl } = require('../src/core/browser-url');
  assert.equal(requestedBrowserUrl('Please open clidey.com for me', 'https://clidey.com/'), 'https://clidey.com/');
  assert.equal(requestedBrowserUrl('Visit https://clidey.com/docs?q=help please', 'https://clidey.com/docs?q=help'), 'https://clidey.com/docs?q=help');
  assert.equal(requestedBrowserUrl('Open clidey.com.', 'https://clidey.com/'), 'https://clidey.com/');
  for (const url of ['https://attacker.example/', 'https://clidey.com/other', 'javascript:alert(1)', 'https://clidey.com/?leak=secret'])
    assert.equal(requestedBrowserUrl('Open clidey.com', url), null);
});
