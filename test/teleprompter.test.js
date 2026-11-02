const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('', { url: 'http://127.0.0.1:4173/' });
test.after(() => dom.window.close());

async function fixture(native, run) {
  dom.window.document.body.innerHTML = '<input id="command"><main id="home"></main><main id="results"></main><span id="count"></span>';
  dom.window.localStorage.clear();
  delete dom.window.webkit;
  const previous = { window: global.window, document: global.document, localStorage: global.localStorage };
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  const messages = [];
  const notices = [];
  if (native) window.webkit = { messageHandlers: { habibiNative: { postMessage: message => messages.push(message) } } };
  const { createTeleprompterFeature } = await import('../src/client/features/teleprompter/teleprompter-feature.js');
  const feature = createTeleprompterFeature({ input: document.querySelector('#command'), defaultView: document.querySelector('#home'), resultsView: document.querySelector('#results'), count: document.querySelector('#count'), notify: text => notices.push(text), onBack() {}, onOpen() {} });
  try { await run({ feature, document, window: dom.window, messages, notices }); }
  finally { Object.assign(global, previous); }
}

test('teleprompter keeps scripts as plain local text and explicitly starts the native overlay', async () => {
  await fixture(true, ({ feature, document, messages, window }) => {
    feature.show();
    assert.equal(document.querySelector('#teleprompter-start').disabled, true);
    const script = document.querySelector('#teleprompter-script');
    assert.equal(script.maxLength, 100000);
    assert.equal(document.querySelector('#teleprompter-pace').min, '60');
    assert.equal(document.querySelector('#teleprompter-pace').max, '260');
    script.value = '<img src=x onerror=alert(1)>\nThis is my script.';
    script.dispatchEvent(new window.Event('input'));
    document.querySelector('#teleprompter-start').click();
    assert.equal(document.querySelector('img'), null);
    assert.deepEqual(messages.at(-1), { type: 'teleprompter', action: 'start', script: script.value, mode: 'voice', pace: 140, fontSize: 24, width: 620 });
    assert.equal(JSON.parse(localStorage.getItem('habibi.teleprompter.v1')).script, script.value);
    feature.show();
    assert.equal(document.querySelector('#teleprompter-script').value, script.value);
  });
});

test('teleprompter controls follow native state and editing preferences do not restart a script', async () => {
  await fixture(true, ({ feature, document, messages, window }) => {
    feature.show();
    window.__habibiTeleprompterState({ state: 'running', visible: true });
    assert.equal(document.querySelector('#teleprompter-toggle').textContent, 'Pause');
    document.querySelector('#teleprompter-toggle').click();
    assert.equal(messages.at(-1).action, 'pause');
    window.__habibiTeleprompterState({ state: 'paused', visible: true });
    document.querySelector('#teleprompter-toggle').click();
    assert.equal(messages.at(-1).action, 'resume');
    const mode = document.querySelector('#teleprompter-mode');
    assert.equal(mode.value, 'voice');
    mode.value = 'automatic';
    mode.dispatchEvent(new window.Event('change'));
    assert.equal(messages.at(-1).mode, 'automatic');
    assert.equal(messages.at(-1).action, 'configure');
    const pace = document.querySelector('#teleprompter-pace');
    pace.value = '180';
    pace.dispatchEvent(new window.Event('change'));
    assert.equal(messages.at(-1).action, 'configure');
    assert.equal(messages.at(-1).pace, 180);
    window.__habibiTeleprompterState({ state: 'paused', mode: 'voice', visible: true, error: 'Microphone access needed' });
    assert.equal(document.querySelector('#teleprompter-toggle').textContent, 'Resume');
    document.querySelector('#teleprompter-reset').click();
    assert.equal(messages.at(-1).action, 'reset');
    document.querySelector('#teleprompter-stop').click();
    assert.equal(messages.at(-1).action, 'stop');
    window.__habibiTeleprompterState({ state: 'stopped', visible: false });
    assert.equal(document.querySelector('#teleprompter-toggle').disabled, true);
  });
});

test('browser-only script editing explains that the floating overlay needs the native app', async () => {
  await fixture(false, ({ feature, document, notices, messages, window }) => {
    feature.show();
    document.querySelector('#teleprompter-script').value = 'A short script';
    document.querySelector('#teleprompter-script').dispatchEvent(new window.Event('input'));
    document.querySelector('#teleprompter-start').click();
    assert.match(notices.at(-1), /Habibi.app/);
    assert.deepEqual(messages, []);
  });
});
