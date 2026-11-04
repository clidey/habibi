const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const image = {
  ok: true,
  dataUrl:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=',
};

test('native image paste stays inline, coalesces requests, and routes only to the active composer', async () => {
  const dom = new JSDOM(
    '<body><section class="habibi-chat"><div id="habibi-attachments"></div><textarea id="habibi-draft"></textarea></section></body>',
    { url: 'http://127.0.0.1:4173' },
  );
  global.window = dom.window;
  global.document = dom.window.document;
  global.File = dom.window.File;
  global.Blob = dom.window.Blob;
  const requests = [];
  const notices = [];
  const attached = [];
  window.webkit = {
    messageHandlers: { habibiNative: { postMessage: (value) => requests.push(value) } },
  };
  window.__habibiAttachPastedFiles = (files) => attached.push(files);
  const { installClipboardImageBridge, requestNativeClipboardImage } =
    await import('../src/client/core/clipboard-images.js');
  installClipboardImageBridge({
    notify: (value) => notices.push(value),
    onFiles: () => assert.fail('Do not leave the active composer'),
  });
  requestNativeClipboardImage();
  requestNativeClipboardImage();
  assert.equal(requests.length, 1);
  assert.ok(document.querySelector('#habibi-attachments [data-native-paste-status]'));
  assert.deepEqual(notices, []);
  await window.__habibiReceiveNativeClipboardImage(image);
  assert.equal(attached.length, 1);
  assert.equal(attached[0][0].type, 'image/png');
  assert.equal(document.querySelector('[data-native-paste-status]'), null);
  document.body.innerHTML =
    '<section class="whatsapp-client"><div id="whatsapp-attachments"></div></section>';
  window.__habibiAttachPastedFiles = () =>
    assert.fail('A stale chat callback must not receive a WhatsApp paste');
  window.__habibiAttachDroppedFiles = (files) => attached.push(files);
  requestNativeClipboardImage();
  await window.__habibiReceiveNativeClipboardImage(image);
  assert.equal(attached.length, 2);
  document.body.innerHTML =
    '<section class="mail-compose"><div class="attachment-list"></div></section>';
  let mail;
  window.__habibiAttachRecentPath = (path, name) => {
    mail = { path, name };
  };
  requestNativeClipboardImage();
  assert.equal(requests.at(-1).context, 'mail');
  await window.__habibiReceiveNativeClipboardImage({ ...image, path: '/Users/demo/copied.png' });
  assert.equal(mail.path, '/Users/demo/copied.png');
  document.body.dataset.workspace = 'clipboard';
  let refreshed = false;
  window.__habibiDailyChanged = () => {
    refreshed = true;
  };
  const count = requests.length;
  window.__habibiNativePasteImage();
  assert.equal(requests.length, count);
  assert.equal(refreshed, true);
  dom.window.close();
});
