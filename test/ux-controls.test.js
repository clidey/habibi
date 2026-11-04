const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..', '..');

test('shared templates render real UX controls while preserving DOM events and sanitization', async () => {
  const dom = new JSDOM('<div id="host"></div>', {
    url: 'http://127.0.0.1:4173/', runScripts: 'dangerously',
  });
  const previous = { window: global.window, document: global.document };
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    dom.window.MessageChannel = class {
      constructor() {
        this.port1 = {};
        this.port2 = { postMessage() {} };
      }
    };
    const script = dom.window.document.createElement('script');
    script.textContent = fs.readFileSync(path.join(root, 'assets/ux.bundle.js'), 'utf8');
    dom.window.document.head.append(script);
    const { setHtml } = await import('../src/client/core/safe-dom.js');
    const host = dom.window.document.querySelector('#host');
    setHtml(host, '<button id="ux-action" data-item="a"><b>Open</b></button><input id="ux-name" value="Draft"><textarea id="ux-body">Hello</textarea><span class="status-pill">Ready</span><kbd>↵</kbd><script>alert(1)</script>');
    const button = host.querySelector('#ux-action');
    assert.equal(button.dataset.slot, 'button');
    assert.equal(button.dataset.item, 'a');
    assert.equal(host.querySelector('#ux-name').dataset.slot, 'input');
    assert.equal(host.querySelector('#ux-name').value, 'Draft');
    assert.equal(host.querySelector('#ux-body').dataset.slot, 'textarea');
    assert.equal(host.querySelector('#ux-body').value, 'Hello');
    assert.equal(host.querySelector('.status-pill').dataset.slot, 'badge');
    assert.equal(host.querySelector('kbd').dataset.slot, 'kbd');
    assert.equal(host.querySelector('script'), null);
    setHtml(host, dom.window.HabibiUx.renderSpinner());
    assert.equal(host.querySelector('[data-slot="spinner"]').getAttribute('data-appearance'), 'brand');
    assert.equal(host.querySelector('[data-slot="spinner"]').getAttribute('aria-hidden'), 'true');
    let clicked = false;
    button.addEventListener('click', () => { clicked = true; });
    button.click();
    assert.equal(clicked, true);
  } finally {
    Object.assign(global, previous);
    dom.window.close();
  }
});
