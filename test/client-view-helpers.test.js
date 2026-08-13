const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

// dompurify binds to whatever `window`/`document` exist at import time, so a
// real DOM must be in place before any client module that touches setHtml is
// first imported anywhere in this process — including transitively, via
// failure-view.js importing safe-dom.js.
const dom = new JSDOM('<div id="host"></div>', { url:'http://127.0.0.1:4173/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

test('approvalNotice produces one consistent sentence regardless of the action', async () => {
  const { approvalNotice } = await import('../src/client/core/view-helpers.js');
  assert.equal(approvalNotice('Sending'), 'Sending only happens after your approval.');
  assert.equal(approvalNotice('Running this tool'), 'Running this tool only happens after your approval.');
  // Same shape for a mid-sentence, lowercase-led subject.
  assert.equal(approvalNotice('sending'), 'sending only happens after your approval.');
});

test('categorizeError keeps plain human-facing messages and rejects internal-looking ones', async () => {
  const { categorizeError } = await import('../src/client/core/failure-view.js');
  const fallback = 'Could not load this.';
  assert.equal(categorizeError(new Error('Your inbox is temporarily unavailable.'), fallback), 'Your inbox is temporarily unavailable.');
  assert.equal(categorizeError(new Error('connect ECONNREFUSED 127.0.0.1:993'), fallback), fallback, 'driver error codes must not reach the user');
  assert.equal(categorizeError(new Error('ENOENT: no such file or directory, open \'/Users/ah/.habibi/x\''), fallback), fallback, 'absolute paths must not reach the user');
  assert.equal(categorizeError(new Error('Error: at Object.<anonymous> (/app/index.js:12:3)'), fallback), fallback, 'stack fragments must not reach the user');
  assert.equal(categorizeError(new Error(''), fallback), fallback, 'an empty message falls back');
  assert.equal(categorizeError(new Error('x'.repeat(200)), fallback), fallback, 'an implausibly long message falls back');
  assert.equal(categorizeError(undefined, fallback), fallback);
});

test('renderFailure renders the categorized message and wires an optional retry', async () => {
  const { renderFailure } = await import('../src/client/core/failure-view.js');
  const host = dom.window.document.querySelector('#host');
  let retried = 0;
  renderFailure(host, new Error('ENOENT: /etc/secret'), { fallback:'Could not load your inbox.', retry:() => { retried += 1; } });
  assert.match(host.textContent, /Could not load your inbox\./);
  assert.doesNotMatch(host.innerHTML, /\/etc\/secret/, 'the leaked path must never reach the DOM');
  const retryButton = host.querySelector('.failure-retry');
  assert.ok(retryButton, 'a retry button must render when retry is provided');
  retryButton.dispatchEvent(new dom.window.Event('click', { bubbles:true }));
  assert.equal(retried, 1);

  renderFailure(host, new Error('Your session expired.'), { fallback:'fallback text' });
  assert.match(host.textContent, /Your session expired\./);
  assert.equal(host.querySelector('.failure-retry'), null, 'no retry button when retry is omitted');
});
