const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

// dompurify binds to whatever `window`/`document` exist at import time, so a
// real DOM must be in place before any client module that touches setHtml is
// first imported anywhere in this process — including transitively, via
// failure-view.js importing safe-dom.js.
const dom = new JSDOM('<div id="host"></div>', { url: 'http://127.0.0.1:4173/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

test('WhoDB datasets retain table structure while untrusted cells remain text', async () => {
  const { whoDbResultMarkup } = await import('../src/client/features/whodb/whodb-results-view.js');
  const { setHtml } = await import('../src/client/core/safe-dom.js');
  const host = document.querySelector('#host');
  const untrusted = '<img src=x onerror="alert(1)">';
  setHtml(host, whoDbResultMarkup({ answer: 'Returned warehouses', datasets: [{
    title: 'Warehouses', columns: ['Warehouse', 'Late'], rows: [['Leeds', 221], [untrusted, 54]],
  }] }));
  assert.deepEqual([...host.querySelectorAll('thead th')].map(cell => cell.textContent), ['Warehouse', 'Late']);
  assert.equal(host.querySelectorAll('tbody tr').length, 2);
  assert.deepEqual([...host.querySelectorAll('tbody td')].map(cell => cell.textContent), ['Leeds', '221', untrusted, '54']);
  assert.equal(host.querySelector('table img, script, [onerror]'), null);
});

test('WhoDB loading mark survives sanitization with its circles and normalized animation paths', async () => {
  const { spinner } = await import('../src/client/core/view-helpers.js');
  const { setHtml } = await import('../src/client/core/safe-dom.js');
  const host = document.querySelector('#host');
  setHtml(host, spinner());
  const mark = host.querySelector('svg.whodb-loader-mark');
  assert.equal(mark.getAttribute('viewBox'), '0 0 120 96');
  assert.equal(mark.getAttribute('aria-hidden'), 'true');
  assert.equal(mark.getAttribute('focusable'), 'false');
  assert.equal(mark.querySelectorAll('circle').length, 5);
  assert.equal(mark.querySelectorAll('path').length, 6);
  assert.equal(mark.querySelector('.whodb-loader-mark__signal').getAttribute('pathLength'), '100');
  assert.equal(mark.querySelector('.whodb-loader-mark__beacon').getAttribute('r'), '6');
  setHtml(host, spinner(true));
  assert.ok(host.querySelector('.whodb-loader-mark--small'));
});

test('WhoDB loading animations pause and resume on document visibility events', async () => {
  const { installSpinnerVisibility } = await import('../src/client/core/view-helpers.js');
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  installSpinnerVisibility();
  assert.equal(document.documentElement.hasAttribute('data-loading-paused'), true);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(document.documentElement.hasAttribute('data-loading-paused'), false);
  delete document.hidden;
});

test('approvalNotice produces one consistent sentence regardless of the action', async () => {
  const { approvalNotice } = await import('../src/client/core/view-helpers.js');
  assert.equal(approvalNotice('Sending'), 'Sending only happens after your approval.');
  assert.equal(
    approvalNotice('Running this tool'),
    'Running this tool only happens after your approval.',
  );
  // Same shape for a mid-sentence, lowercase-led subject.
  assert.equal(approvalNotice('sending'), 'sending only happens after your approval.');
});

test('categorizeError keeps plain human-facing messages and rejects internal-looking ones', async () => {
  const { categorizeError } = await import('../src/client/core/failure-view.js');
  const fallback = 'Could not load this.';
  assert.equal(
    categorizeError(new Error('Your inbox is temporarily unavailable.'), fallback),
    'Your inbox is temporarily unavailable.',
  );
  assert.equal(
    categorizeError(new Error('connect ECONNREFUSED 127.0.0.1:993'), fallback),
    fallback,
    'driver error codes must not reach the user',
  );
  assert.equal(
    categorizeError(
      new Error("ENOENT: no such file or directory, open '/Users/ah/.habibi/x'"),
      fallback,
    ),
    fallback,
    'absolute paths must not reach the user',
  );
  assert.equal(
    categorizeError(new Error('Error: at Object.<anonymous> (/app/index.js:12:3)'), fallback),
    fallback,
    'stack fragments must not reach the user',
  );
  assert.equal(categorizeError(new Error(''), fallback), fallback, 'an empty message falls back');
  assert.equal(
    categorizeError(new Error('x'.repeat(200)), fallback),
    fallback,
    'an implausibly long message falls back',
  );
  assert.equal(categorizeError(undefined, fallback), fallback);
});

test('renderFailure renders the categorized message and wires an optional retry', async () => {
  const { renderFailure } = await import('../src/client/core/failure-view.js');
  const host = dom.window.document.querySelector('#host');
  let retried = 0;
  renderFailure(host, new Error('ENOENT: /etc/secret'), {
    fallback: 'Could not load your inbox.',
    retry: () => {
      retried += 1;
    },
  });
  assert.match(host.textContent, /Could not load your inbox\./);
  assert.doesNotMatch(host.innerHTML, /\/etc\/secret/, 'the leaked path must never reach the DOM');
  const retryButton = host.querySelector('.failure-retry');
  assert.ok(retryButton, 'a retry button must render when retry is provided');
  retryButton.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(retried, 1);

  renderFailure(host, new Error('Your session expired.'), { fallback: 'fallback text' });
  assert.match(host.textContent, /Your session expired\./);
  assert.equal(host.querySelector('.failure-retry'), null, 'no retry button when retry is omitted');
});

test('Ask file matches use compact launcher rows and preserve escaped file identities', async () => {
  const { fileResultsMarkup } = await import('../src/client/features/llm/file-results-view.js');
  const { setHtml } = await import('../src/client/core/safe-dom.js');
  const host = document.querySelector('#host');
  const files = [
    { name: 'Overview.pdf', folder: 'Documents', directory: '~/Documents/Projects', path: '/demo/Overview.pdf' },
    { name: '<img src=x onerror=alert(1)>.md', folder: 'Downloads', directory: '~/Downloads', path: '/demo/notes & ideas.md' },
  ];
  setHtml(host, fileResultsMarkup(files));
  const rows = host.querySelectorAll('.result');
  assert.equal(rows.length, 2);
  assert.match(host.querySelector('.result-header').textContent, /Local files2 matches/);
  assert.equal(host.querySelector('.agent-file, .agent-file-results--visual'), null);
  assert.equal(rows[0].querySelector('.result-title').textContent, 'Overview.pdf');
  assert.equal(rows[0].querySelector('.result-meta').textContent, 'Documents · ~/Documents/Projects');
  assert.equal(rows[0].querySelector('.result-tag').textContent, 'FILE');
  assert.equal(rows[0].getAttribute('draggable'), 'true');
  assert.equal(decodeURIComponent(rows[1].dataset.path), files[1].path);
  assert.equal(rows[1].querySelector('.result-title').textContent, files[1].name);
  assert.equal(rows[1].querySelector('img, script, [onerror]'), null);
});
