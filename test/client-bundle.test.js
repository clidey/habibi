const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..', '..');
const bundlePath = path.join(root, 'assets', 'app.bundle.js');
const indexPath = path.join(root, 'index.html');
const stylesheetPath = path.join(root, 'app.css');

test('native launcher corners use the intended treatment for every theme', () => {
  const themes = ['deep-ocean', 'midnight-noir', 'aurora-glass', 'forest-moss', 'solar-gold', 'velvet-rose', 'boring-good'];
  const stylesheet = fs.readFileSync(stylesheetPath, 'utf8');
  assert.ok(
    stylesheet.lastIndexOf('body.native-host:not([data-theme="deep-ocean"]) .command-card') > stylesheet.lastIndexOf('body[data-theme="boring-good"] .command-card'),
    'the native opaque-edged surface must override full-page theme backgrounds'
  );

  for (const theme of themes) {
    const dom = new JSDOM(`<style>${stylesheet}</style><body class="native-host" data-theme="${theme}"></body>`, { pretendToBeVisual:true });
    const style = dom.window.getComputedStyle(dom.window.document.body);
    assert.equal(style.backgroundColor, 'rgba(0, 0, 0, 0)', `${theme} must not paint a rectangular native background`);
    assert.equal(style.backgroundImage, 'none', `${theme} must not leave a page gradient behind the launcher`);
    dom.window.close();
  }
});

// The unit tests import individual modules, so they cannot catch a module that
// never resolves a binding at load time — a missing import bundles cleanly and
// then throws a ReferenceError the moment the UI renders. This boots the real
// built bundle against a DOM so that failure surfaces in CI, not in the app.
test('the built client bundle boots without runtime errors', async () => {
  assert.ok(fs.existsSync(bundlePath), 'run the build before this test');
  const dom = new JSDOM(fs.readFileSync(indexPath, 'utf8'), {
    url:'http://127.0.0.1:4173/',
    runScripts:'outside-only',
    pretendToBeVisual:true,
  });
  const errors = [];
  dom.window.addEventListener('error', event => errors.push(event.error || event.message));
  // The launcher polls several endpoints on boot. Returning empty payloads keeps
  // those paths inert; leaving fetch unstubbed would let the requests outlive
  // the test and surface as unhandled rejections.
  dom.window.fetch = async () => ({ ok:true, json:async () => ({ ok:false, skills:[], threads:[], events:[], agents:[], apps:[] }), text:async () => '' });
  dom.window.matchMedia ||= () => ({ matches:false, addEventListener() {}, removeEventListener() {} });
  dom.window.lucide = { createIcons() {} };

  try {
    dom.window.eval(fs.readFileSync(bundlePath, 'utf8'));
  } catch (error) {
    assert.fail(`the bundle threw while loading: ${error.message}`);
  }
  // The launcher's own markup must survive the sanitizing render path: if the
  // DOMPurify allowlist were too tight, the UI would silently render empty.
  const { document } = dom.window;
  assert.ok(document.querySelector('#command-input'), 'the command input should exist');

  // Let the boot-time fetches settle so a rejection is attributed to this test
  // rather than leaking into the next one.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('the sanitizing render path strips script while keeping launcher markup', async () => {
  const dom = new JSDOM('<div id="host"></div>', { url:'http://127.0.0.1:4173/' });
  const previous = { window:globalThis.window, document:globalThis.document };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const { setHtml } = await import('../src/client/core/safe-dom.js');
    const host = dom.window.document.querySelector('#host');

    setHtml(host, '<span>safe</span><script>globalThis.PWNED = true;</script>');
    assert.equal(host.querySelector('script'), null, 'script must be stripped');
    assert.equal(dom.window.PWNED, undefined);
    assert.match(host.innerHTML, /safe/);

    setHtml(host, '<img src="x" onerror="globalThis.PWNED = true">');
    assert.equal(host.querySelector('img')?.hasAttribute('onerror'), false, 'event handlers must be stripped');

    // Real launcher markup, including the data-* attributes it reads back.
    setHtml(host, '<button class="result" data-type="chat" data-title="Amina"><span class="result-title">Amina</span></button>');
    assert.equal(host.querySelector('button')?.dataset.title, 'Amina');
    assert.equal(host.querySelector('.result-title')?.textContent, 'Amina');

    setHtml(host, '<input type="checkbox" id="analytics-enabled" checked>');
    assert.equal(host.querySelector('#analytics-enabled')?.checked, true, 'sanitizing settings markup must preserve checked state');

    setHtml(host, '<input type="file" id="whatsapp-file-input" multiple hidden>');
    assert.equal(host.querySelector('#whatsapp-file-input')?.hidden, true, 'native file controls must remain hidden behind the styled attachment button');
    assert.equal(host.querySelector('#whatsapp-file-input')?.multiple, true, 'attachment pickers must retain multi-file selection');
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test('reopening Home reuses the recent proactive context', async () => {
  const dom = new JSDOM(fs.readFileSync(indexPath, 'utf8'), {
    url:'http://127.0.0.1:4173/',
    runScripts:'outside-only',
    pretendToBeVisual:true,
  });
  let recentRequests = 0;
  dom.window.localStorage.setItem('habibi.getting-started.dismissed.v1', 'done');
  dom.window.fetch = async url => {
    if (String(url).startsWith('/api/mail/status')) return { json:async () => ({ ok:true, accounts:[{ connected:true }] }) };
    if (String(url).startsWith('/api/mail/recent')) { recentRequests += 1; return { json:async () => ({ ok:true, threads:[] }) }; }
    return { ok:true, json:async () => ({ ok:false, events:[] }), text:async () => '' };
  };
  dom.window.matchMedia ||= () => ({ matches:false, addEventListener() {}, removeEventListener() {} });
  dom.window.lucide = { createIcons() {} };
  dom.window.eval(fs.readFileSync(bundlePath, 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(recentRequests, 1);
  dom.window.__habibiResetLauncher();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(recentRequests, 1, 'a quick launcher reopen must not repeat the mail refresh');
  dom.window.close();
});
