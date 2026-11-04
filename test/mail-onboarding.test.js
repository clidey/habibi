const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('mail onboarding finishes account checking and routes each aligned provider row safely', async () => {
  const dom = new JSDOM('<input id="command"><main id="home"></main><main id="results"></main><span id="count"></span>', { url: 'http://127.0.0.1:4173/' });
  const previous = { window: global.window, document: global.document, fetch: global.fetch };
  global.window = dom.window;
  global.document = dom.window.document;
  const hostile = '\"><img src=x onerror=alert(1)>';
  global.fetch = async () => ({ json: async () => ({ ok: true, accounts: [], providers: [
    { id: 'gmail', label: 'Gmail', configured: false },
    { id: 'zoho', label: 'Zoho Mail', configured: true },
    { id: hostile, label: hostile, configured: false },
  ] }) });
  const selected = [];
  try {
    const { createMailInbox } = await import('../src/client/features/mail/mail-inbox.js');
    const inbox = createMailInbox({ input: document.querySelector('#command'), defaultView: document.querySelector('#home'), resultsView: document.querySelector('#results'), count: document.querySelector('#count'), onHome() {}, onOpen() {}, showMailThread() {}, showMailSettings() {}, showMailProviderSetup: id => selected.push(id) });
    inbox.show();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(document.querySelector('#count').textContent, 'Mail · connect an account');
    const rows = [...document.querySelectorAll('[data-mail-provider]')];
    assert.equal(rows.length, 3);
    assert.equal(rows[0].querySelector('.mail-provider-copy b').textContent, 'Gmail');
    assert.equal(rows[0].querySelector('.mail-provider-action').textContent, 'SET UP');
    assert.equal(rows[1].querySelector('.mail-provider-action').textContent, 'CONNECT');
    rows[0].click(); rows[1].click();
    assert.deepEqual(selected, ['gmail', 'zoho']);
    assert.equal(document.querySelector('img'), null);
    assert.equal(rows[2].dataset.mailProvider, hostile);
    assert.equal(rows[2].querySelector('b').textContent, hostile);
  } finally { Object.assign(global, previous); dom.window.close(); }
});
