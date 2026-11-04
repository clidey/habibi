const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('Settings saves the default web search provider and validates the choice', async () => {
  const dom = new JSDOM('<div id="settings"></div>', { url: 'http://127.0.0.1:4173/' });
  const previous = { window: global.window, document: global.document, localStorage: global.localStorage };
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  try {
    const { installWebSearchSettings } = await import('../src/client/features/settings/web-search-settings.js');
    const { getWebSearchProvider, setWebSearchProvider, webSearchDestination } = await import('../src/client/core/web-search-provider.js');
    assert.equal(getWebSearchProvider(), 'google');
    installWebSearchSettings(document.querySelector('#settings'));
    const fallback = document.querySelector('.web-search-fallback');
    assert.equal(fallback.value, 'google');
    assert.equal(document.querySelector('script[src="/assets/ux.bundle.js"]') !== null, true);
    assert.equal(document.querySelector('link[href="/assets/styles/ux.css"]') !== null, true);
    fallback.value = 'duckduckgo';
    fallback.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(getWebSearchProvider(), 'duckduckgo');
    assert.deepEqual(webSearchDestination('Delhi to Dehradun & back'), {
      name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=Delhi%20to%20Dehradun%20%26%20back',
    });
    assert.equal(setWebSearchProvider('https://evil.example'), false);
    assert.equal(getWebSearchProvider(), 'duckduckgo');
    localStorage.setItem('habibi.web-search-provider', 'invalid');
    assert.equal(getWebSearchProvider(), 'google');
  } finally {
    Object.assign(global, previous);
    dom.window.close();
  }
});

test('Settings bundles the published Clidey UX Select separately from the launcher', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(typeof manifest.devDependencies['@clidey/ux'], 'string');
  const uxBundle = fs.readFileSync(path.join(root, 'assets/ux.bundle.js'), 'utf8');
  const launcher = fs.readFileSync(path.join(root, 'assets/app.bundle.js'), 'utf8');
  assert.match(uxBundle, /select-trigger/);
  assert.doesNotMatch(launcher, /select-trigger/);
  assert.ok(fs.statSync(path.join(root, 'assets/styles/ux.css')).size > 100_000);
});

test('default searches use the saved engine while explicit engines and Airbnb keep their own destination', async () => {
  const dom = new JSDOM('<div id="results"></div>', { url: 'http://127.0.0.1:4173/' });
  const previous = { window: global.window, document: global.document,
    localStorage: global.localStorage, fetch: global.fetch };
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  const opened = [];
  global.fetch = async (url, options) => {
    if (url === '/api/approvals') {
      opened.push(JSON.parse(options.body).payload.url);
      return { json: async () => ({ ok: true, approval: { token: 'once' } }) };
    }
    return { json: async () => ({ ok: true }) };
  };
  try {
    const { createIntentRouter } = await import('../src/client/features/routing/intent-router.js');
    const router = createIntentRouter({ notify() {} });
    localStorage.setItem('habibi.web-search-provider', 'bing');
    assert.equal((await router.openBrowser({ action: 'browser_search', provider: 'default', query: 'bus Delhi to Dehradun' })).ok, true);
    assert.equal(opened.at(-1), 'https://www.bing.com/search?q=bus%20Delhi%20to%20Dehradun');
    await router.openBrowser({ action: 'browser_search', provider: 'google', query: 'weather' });
    assert.equal(opened.at(-1), 'https://www.google.com/search?q=weather');
    await router.openBrowser({ action: 'browser_search', provider: 'airbnb', query: 'Paris', adults: 2 });
    assert.match(opened.at(-1), /^https:\/\/www\.airbnb\.co\.uk\/s\/homes\?query=Paris&adults=2$/);
  } finally {
    Object.assign(global, previous);
    dom.window.close();
  }
});
