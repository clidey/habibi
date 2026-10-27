const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..', '..');
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

async function launcher(run) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), { url: 'http://127.0.0.1:4173/', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.localStorage.setItem('habibi.getting-started.dismissed.v1', 'done');
  const requests = [];
  dom.window.whodbIcons = { createIcons() {} };
  dom.window.fetch = async (url, options) => {
    requests.push([url, options]);
    const data = url === '/api/llm/status' ? { ok: true, configured: false } : String(url).startsWith('/api/files') ? [] : { ok: true, accounts: [], apps: [], providers: [], events: [] };
    return { ok: true, json: async () => data, text: async () => '' };
  };
  dom.window.eval(fs.readFileSync(path.join(root, 'assets/app.bundle.js'), 'utf8'));
  try { await settle(); await run(dom.window, requests); } finally { dom.window.close(); }
}

test('Ask opens without a configured model and Escape returns to Home', async () => {
  await launcher(async (window) => {
    const document = window.document;
    document.querySelector('[data-workspace-link="ask"]').click();
    await settle();
    assert.ok(document.querySelector('#ask-welcome'));
    assert.equal(document.body.dataset.workspace, 'ask');
    assert.equal(document.querySelector('#send-habibi').disabled, false);
    document.querySelector('#habibi-draft').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert.equal(document.body.dataset.workspace, 'home');
    assert.equal(document.querySelector('#default-view').classList.contains('hidden'), false);
  });
});

test('a sentence opens Ask with its request instead of executing a guessed calendar action', async () => {
  await launcher(async (window, requests) => {
    const document = window.document;
    const input = document.querySelector('#command-input');
    input.value = 'Lunch with Sana Friday 1pm';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();
    assert.match(document.querySelector('#routing-strip').textContent, /HABIBI/);
    assert.equal(document.querySelector('.result').dataset.type, 'assistant');
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    assert.equal(document.body.dataset.workspace, 'ask');
    assert.equal(document.querySelector('#habibi-draft').value, 'Lunch with Sana Friday 1pm');
    assert.equal(document.querySelector('#create-event'), null);
    assert.ok(!requests.some(([url]) => /^\/api\/(?:calendar\/event|approvals)/.test(url)));
  });
});

test('WhoDB URL preferences reject executable URLs and do not invent a connected session', async () => {
  await launcher(async (window) => {
    const document = window.document;
    document.querySelector('[data-workspace-link="whodb"]').click();
    await settle();
    const field = document.querySelector('#whodb-instance');
    assert.equal(field.value, 'https://app.whodb.com');
    assert.equal(document.querySelector('#sign-in-whodb').disabled, false);
    field.value = 'javascript:alert(1)';
    field.dispatchEvent(new window.Event('input'));
    document.querySelector('#save-whodb-instance').click();
    assert.equal(window.localStorage.getItem('habibi.whodb.instance'), null);
    assert.equal(document.querySelector('#open-whodb-instance').hasAttribute('href'), false);
    field.value = 'https://demo.example.test';
    document.querySelector('#save-whodb-instance').click();
    assert.equal(window.localStorage.getItem('habibi.whodb.instance'), 'https://demo.example.test/');
    await settle();
    assert.match(document.querySelector('.status-pill').textContent, /Not connected/);
  });
});

test('WhoDB sign-in opens the server-owned login URL and waits once, without polling', async () => {
  await launcher(async (window, requests) => {
    const document = window.document;
    const originalFetch = window.fetch;
    let finish;
    window.fetch = async (url, options) => {
      if (!String(url).startsWith('/api/whodb/login')) return originalFetch(url, options);
      requests.push([url, options]);
      let data = { ok: true };
      if (url === '/api/whodb/login') data = { ok: true, id: 'pending-login', host: 'https://app.whodb.com', url: 'https://auth.example.test/authorize?state=one-time' };
      if (url === '/api/whodb/login/wait') data = await new Promise((resolve) => { finish = resolve; });
      if (url === '/api/whodb/login/cancel') finish({ ok: false });
      return { json: async () => data };
    };
    document.querySelector('[data-workspace-link="whodb"]').click();
    await settle();
    document.querySelector('#sign-in-whodb').click();
    await settle();
    assert.equal(document.querySelector('#sign-in-whodb').disabled, true);
    assert.match(document.querySelector('#whodb-sign-in-status a').href, /^https:\/\/auth\.example\.test/);
    const loginRequests = requests.filter(([url]) => String(url).startsWith('/api/whodb/login'));
    assert.deepEqual(loginRequests.map(([url]) => url), ['/api/whodb/login', '/api/whodb/login/open', '/api/whodb/login/wait']);
    assert.deepEqual(JSON.parse(loginRequests[0][1].body), { host: 'https://app.whodb.com' });
    assert.deepEqual(JSON.parse(loginRequests[1][1].body), { id: 'pending-login' });
    document.querySelector('#cancel-whodb-sign-in').click();
    await settle();
    assert.equal(document.querySelector('#sign-in-whodb').disabled, false);
    assert.match(document.querySelector('#whodb-sign-in-status').textContent, /cancelled/);
  });
});

test('saved WhoDB sign-in stays distinct from failed workspace loading and accounts with no organizations', async () => {
  await launcher(async (window) => {
    const originalFetch = window.fetch;
    let scope = { ok: false, error: 'Workspace request failed' };
    window.fetch = async (url, options) => {
      const data = url === '/api/whodb/status' ? { ok: true, connected: true, auth: 'sso', host: 'https://app.whodb.com', servers: [] } : url === '/api/whodb/scope' ? scope : null;
      return data ? { json: async () => data } : originalFetch(url, options);
    };
    const document = window.document;
    document.querySelector('[data-workspace-link="whodb"]').click();
    await settle();
    assert.equal(document.querySelector('#sign-in-whodb'), null);
    assert.ok(document.querySelector('#retry-whodb-workspace'));
    assert.match(document.querySelector('.status-pill').textContent, /Signed in/);
    scope = { ok: true, orgs: [], org: null, projects: [] };
    document.querySelector('#retry-whodb-workspace').click();
    await settle();
    assert.equal(document.querySelector('#sign-in-whodb'), null);
    assert.match(document.querySelector('#results-view .clear-day').textContent, /No organizations/);
    scope = { ok: false, code: 'WHODB_SIGN_IN_REQUIRED' };
    document.querySelector('#retry-whodb-workspace').click();
    await settle();
    assert.ok(document.querySelector('#sign-in-whodb'));
    assert.match(document.querySelector('#whodb-sign-in-status').textContent, /saved session could not be restored/);
    assert.match(document.querySelector('.status-pill').textContent, /Sign in again/);
  });
});

test('website sentences open Ask without executing when no model is configured', async () => {
  await launcher(async (window, requests) => {
    const input = window.document.querySelector('#command-input');
    input.value = 'open clidey.com';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();
    assert.match(window.document.querySelector('.result').textContent, /Ask Habibi/);
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    assert.equal(window.document.body.dataset.workspace, 'ask');
    assert.equal(window.document.querySelector('#habibi-draft').value, 'open clidey.com');
    assert.equal(requests.some(([url]) => ['/api/approvals', '/api/browser/open'].includes(url)), false);
  });
});

test('Ask submits the sentence to its configured model router before opening the approved destination', async () => {
  await launcher(async (window, requests) => {
    const originalFetch = window.fetch;
    window.fetch = async (url, options) => {
      const replies = {
        '/api/llm/status': { ok: true, configured: true, provider: 'openai', model: 'test-model' },
        '/api/agent/route': { ok: true, action: 'open_url', url: 'https://clidey.com/' },
        '/api/approvals': { ok: true, approval: { token: 'website-once' } },
        '/api/browser/open': { ok: true },
      };
      if (!replies[url]) return originalFetch(url, options);
      requests.push([url, options]);
      return { json: async () => replies[url] };
    };
    const input = window.document.querySelector('#command-input');
    input.value = 'Please open clidey.com for me';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    await settle();
    assert.equal(window.document.body.dataset.workspace, 'ask');
    const actions = requests.filter(([url]) => ['/api/agent/route', '/api/approvals', '/api/browser/open'].includes(url));
    assert.deepEqual(actions.map(([url]) => url), ['/api/agent/route', '/api/approvals', '/api/browser/open']);
    assert.equal(JSON.parse(actions[0][1].body).text, 'Please open clidey.com for me');
    assert.deepEqual(JSON.parse(actions[1][1].body), { action: 'browser.open', payload: { url: 'https://clidey.com/' } });
    assert.deepEqual(JSON.parse(actions[2][1].body), { url: 'https://clidey.com/', approvalToken: 'website-once' });
    assert.match(window.document.querySelector('#habibi-messages').textContent, /Opened clidey.com/);
  });
});
