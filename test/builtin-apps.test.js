const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('exact Notes commands open immediately before the debounced search renders', async () => {
  const dom = new JSDOM(
    '<input id="command-input"><section id="default-view"></section><section id="results-view" class="hidden"></section>',
    { url: 'http://127.0.0.1:4173' },
  );
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.localStorage = dom.window.localStorage;
  const { installAppInteractions } = await import('../src/client/app-interactions.js');
  const calls = [];
  const input = document.querySelector('input');
  let mode = null;
  installAppInteractions({
    input,
    defaultView: document.querySelector('#default-view'),
    resultsView: document.querySelector('#results-view'),
    getMode: () => mode,
    resultActions: { showAction: (type) => calls.push(type) },
    onActivity() {},
    renderSearch() {},
    notes: { handleKey: () => false },
    notify() {},
  });
  for (const value of ['notes', 'my notes', 'open notes', 'show my notes']) {
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input'));
    const event = new dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  }
  assert.deepEqual(calls, ['notes', 'notes', 'notes', 'notes']);
  input.value = 'notes about the trip';
  input.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
  );
  assert.equal(calls.length, 4);
  dom.window.close();
});

test('Habibi apps have a shared identity while installed apps and documents retain their icons', async () => {
  const { createResultButton } = await import('../src/client/ui/result-button.js');
  const render = createResultButton({
    icon: (name) => `<i data-ux-icon="${name}"></i>`,
    chatTime: () => '',
    iconNames: {},
  });
  const builtin = render({ type: 'notes', title: 'Notes', icon: 'file-text', tag: 'APP' }, 0);
  assert.match(builtin, /data-habibi-app="notes"/);
  assert.match(builtin, /habibi-app-icon/);
  assert.match(builtin, />HABIBI</);
  const external = render(
    {
      type: 'app',
      title: 'Notes',
      icon: 'file-text',
      path: '/System/Applications/Notes.app',
      appIcon: 'http://127.0.0.1:4173/api/app-icon',
    },
    1,
  );
  assert.doesNotMatch(external, /data-habibi-app|habibi-app-icon/);
  const documentResult = render(
    { type: 'file', title: 'Notes.md', icon: 'file-text', path: '/tmp/Notes.md' },
    2,
  );
  assert.doesNotMatch(documentResult, /data-habibi-app|habibi-app-icon/);
});
