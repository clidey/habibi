const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

async function withActions(run) {
  const dom = new JSDOM('<input id="command"><div id="results"></div>');
  globalThis.document = dom.window.document;
  const originalFetch = globalThis.fetch;
  const calls = [];
  const record = name => (...args) => { calls.push([name, ...args]); return { ok: true }; };
  globalThis.fetch = async url => {
    calls.push(['fetch', url]);
    return { json: async () => url.startsWith('/api/apps') ? { ok: true, apps: [{ name: 'Safari', path: '/System/Applications/Safari.app' }] } : { ok: true, session: { status: 'ready' } } };
  };
  try {
    const { createCapabilityActions } = await import('../src/client/features/routing/capability-actions.js');
    const actions = createCapabilityActions({
      input: document.querySelector('#command'), resultsView: document.querySelector('#results'),
      platformActions: { openFolder: record('folder'), openApp: record('app'), showSystem: record('system-preview'), showRunning: record('running-apps-preview') },
      mail: { showClient: record('mail'), showComposer: record('mail-draft') },
      whatsapp: { showChats: record('whatsapp-search') }, whatsappSetup: { show: record('whatsapp-link') },
      calendar: { showUpcoming: record('calendar'), showDraft: record('calendar-draft') },
      kubernetes: { show: record('kubernetes') }, openWhoDb: record('whodb'), openBrowser: record('browser'), routeWhatsApp: record('whatsapp-draft'),
    });
    await run(actions, calls);
  } finally { globalThis.fetch = originalFetch; delete globalThis.document; dom.window.close(); }
}

test('folder, website, app and Airbnb plans invoke the actual bounded openers', async () => {
  await withActions(async (actions, calls) => {
    assert.equal((await actions.execute({ action: 'open_folder', folder: 'Downloads' }, 'open downloads')).ok, true);
    await actions.execute({ action: 'open_url', url: 'https://clidey.com/' }, 'open clidey website');
    await actions.execute({ action: 'browser_search', provider: 'airbnb', query: 'Paris', adults: 2 }, 'Airbnb Paris');
    await actions.execute({ action: 'open_app', app: 'Safari' }, 'launch Safari');
    assert.deepEqual(calls.find(call => call[0] === 'folder'), ['folder', 'Downloads']);
    assert.equal(calls.filter(call => call[0] === 'browser').length, 2);
    const app = calls.find(call => call[0] === 'app')[1];
    assert.equal(decodeURIComponent(app.dataset.path), '/System/Applications/Safari.app');
    assert.equal(calls.some(call => String(call[1]).includes('files/investigate')), false);
  });
});

test('Mail, WhatsApp, Calendar and system actions prepare UI rather than sending or writing', async () => {
  await withActions(async (actions, calls) => {
    await actions.execute({ action: 'mail', mode: 'search', query: 'invoices' }, 'find invoices in mail');
    await actions.execute({ action: 'mail', mode: 'compose', to: 'maya@example.test', subject: 'Demo', body: 'Hello' }, 'draft email');
    await actions.execute({ action: 'whatsapp', mode: 'search', target: 'Maya' }, 'find Maya on WhatsApp');
    await actions.execute({ action: 'whatsapp', mode: 'message', target: 'Maya', instruction: 'Say hello' }, 'message Maya');
    await actions.execute({ action: 'calendar', mode: 'draft' }, 'Lunch tomorrow at 1pm');
    await actions.execute({ action: 'system', name: 'shutdown' }, 'shut down');
    assert.deepEqual(calls.find(call => call[0] === 'mail'), ['mail', { query: 'invoices' }]);
    assert.deepEqual(calls.find(call => call[0] === 'mail-draft').slice(1), ['New email', undefined, { to: 'maya@example.test', subject: 'Demo', body: 'Hello' }]);
    assert.deepEqual(calls.find(call => call[0] === 'whatsapp-search'), ['whatsapp-search', { query: 'Maya' }]);
    assert.equal(calls.find(call => call[0] === 'whatsapp-draft')[1].instruction, 'Say hello');
    assert.match(calls.find(call => call[0] === 'calendar-draft')[1].title, /Lunch/);
    assert.deepEqual(calls.find(call => call[0] === 'system-preview'), ['system-preview', 'shutdown', 'shutdown']);
    assert.equal(calls.some(call => /send|calendar\/event|system\/action/.test(String(call[1]))), false);
  });
});

test('capability open failures do not claim that an action succeeded', async () => {
  await withActions(async (actions, calls) => {
    const result = await actions.execute({ action: 'exec', command: 'anything' }, 'run it');
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });
});
