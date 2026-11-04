const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('menu bar preference reads native state and applies both directions without changing shortcut access', async () => {
  const dom = new JSDOM('<section id="settings"><div class="settings-section"></div></section>');
  global.window = dom.window;
  global.document = dom.window.document;
  const calls = [];
  window.webkit = {
    messageHandlers: { habibiNative: { postMessage: (message) => calls.push(message) } },
  };
  document.body.dataset.nativeShortcutLabel = '⌘ Space';
  const { installMenuBarSettings, closeMenuBarSettings } =
    await import('../src/client/features/settings/menu-bar-settings.js');
  const root = document.querySelector('#settings');
  installMenuBarSettings(root);
  const toggle = root.querySelector('#menu-bar-icon-enabled');
  assert.equal(toggle.disabled, true);
  assert.deepEqual(calls.shift(), { type: 'menuBarIconState' });
  window.__habibiMenuBarIconState({ enabled: true });
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);
  toggle.checked = false;
  toggle.dispatchEvent(new window.Event('change'));
  assert.deepEqual(calls.shift(), { type: 'menuBarIcon', enabled: false });
  assert.equal(toggle.disabled, true);
  window.__habibiMenuBarIconState({ enabled: false });
  assert.match(root.textContent, /⌘ Space.*Habibi.app/);
  assert.equal(toggle.disabled, false);
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change'));
  assert.deepEqual(calls.shift(), { type: 'menuBarIcon', enabled: true });
  window.__habibiMenuBarIconState({ enabled: true });
  assert.equal(toggle.checked, true);
  closeMenuBarSettings();
  assert.equal(window.__habibiMenuBarIconState, undefined);
  root.replaceChildren();
  delete window.webkit;
  installMenuBarSettings(root);
  assert.equal(root.children.length, 0, 'browser settings omit the native-only preference');
  dom.window.close();
});
