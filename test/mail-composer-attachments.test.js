const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('recent files remain in a mail draft until Send approves the exact attachment list', async () => {
  const dom = new JSDOM('<div id="home"></div><div id="results"></div><span id="count"></span>', {
    url: 'http://127.0.0.1:4173',
  });
  global.window = dom.window;
  global.document = dom.window.document;
  const sends = [];
  const approvals = [];
  global.fetch = async (url, options) => {
    if (url === '/api/mail/status')
      return {
        json: async () => ({
          ok: true,
          accounts: [{ id: 'demo', connected: true, provider: 'gmail', email: 'demo@example.com' }],
        }),
      };
    assert.equal(url, '/api/mail/send');
    sends.push(JSON.parse(options.body));
    return { json: async () => ({ ok: true }) };
  };
  const { createMailComposer } = await import('../src/client/features/mail/mail-composer.js');
  const composer = createMailComposer({
    defaultView: document.querySelector('#home'),
    resultsView: document.querySelector('#results'),
    count: document.querySelector('#count'),
    notify() {},
    showMailClient() {},
    requestApproval: async (action, payload) => {
      approvals.push({ action, payload });
      return 'fixture-token';
    },
  });
  composer.show('New email', undefined, {
    to: 'person@example.com',
    subject: 'Demo',
    body: 'A fictional message.',
  });
  await new Promise((resolve) => setImmediate(resolve));
  window.__habibiAttachRecentPath('/Users/demo/plan.txt', 'plan.txt');
  window.__habibiAttachRecentPath('/Users/demo/plan.txt', 'plan.txt');
  window.__habibiAttachRecentPath('/Users/demo/extra.txt', 'extra.txt');
  document.querySelector('[aria-label="Remove extra.txt"]').click();
  assert.equal(document.querySelectorAll('.attachment').length, 1);
  assert.equal(sends.length, 0);
  assert.equal(approvals.length, 0);
  document.querySelector('#send-email').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(approvals[0].action, 'mail.send');
  assert.deepEqual(approvals[0].payload.attachments, [
    { path: '/Users/demo/plan.txt', name: 'plan.txt' },
  ]);
  assert.deepEqual(sends[0].attachments, approvals[0].payload.attachments);
  assert.equal(sends[0].approvalToken, 'fixture-token');
  dom.window.close();
});
