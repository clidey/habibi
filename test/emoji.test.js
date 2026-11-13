const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const root = fs.existsSync(path.join(__dirname, '../assets/emoji-catalog.json'))
  ? path.join(__dirname, '..') : path.join(__dirname, '..', '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'assets/emoji-catalog.json'), 'utf8'));

test('the offline catalog includes every pinned Unicode 18 emoji and reachable variants', async () => {
  const { createCatalog, emojiSections, searchEmoji } = await import('../src/client/features/emoji/emoji-catalog.js');
  const catalog = createCatalog(data.entries);
  assert.equal(data.version, '18.0');
  assert.equal(data.entries.length, 3972);
  assert.equal(data.entries.filter(entry => entry.v === '18.0').length, 19);
  assert.equal(new Set(data.entries.map(entry => entry.e)).size, data.entries.length);
  for (const entry of data.entries) {
    assert.ok(catalog.variants.get(entry.b || entry.e)?.includes(entry), `${entry.e} must be browsable`);
    assert.ok(emojiSections(catalog, 'all', entry.e, []).some(section => section.entries.includes(entry)),
      `${entry.e} must be searchable`);
  }
  assert.equal(searchEmoji(catalog, 'strong')[0].e, '💪');
  assert.ok(catalog.variants.get('👍').some(entry => entry.e === '👍🏽'));
  assert.ok(catalog.variants.get('🧑‍🎓').some(entry => entry.e === '👩‍🎓'));
});

test('picker searches, selects a variant, copies explicitly, and saves recent picks', async () => {
  const dom = new JSDOM('<input id="command"><main id="home"></main><main id="results"></main><span id="count"></span>', {
    url: 'http://127.0.0.1:4173/', pretendToBeVisual: true,
  });
  const previous = { window: global.window, document: global.document,
    localStorage: global.localStorage, fetch: global.fetch };
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  global.fetch = async () => ({ ok: true, json: async () => data });
  const messages = [];
  dom.window.webkit = { messageHandlers: { habibiNative: { postMessage(message) {
    messages.push(message);
    queueMicrotask(() => dom.window.__habibiEmojiCopyResult?.(true));
  } } } };
  try {
    const { createEmojiFeature } = await import('../src/client/features/emoji/emoji-feature.js');
    const input = document.querySelector('#command');
    const resultsView = document.querySelector('#results');
    const notices = [];
    const feature = createEmojiFeature({ input, defaultView: document.querySelector('#home'),
      resultsView, count: document.querySelector('#count'), notify: message => notices.push(message),
      onBack() {}, onOpen() {} });
    await feature.show();
    assert.equal(resultsView.querySelectorAll('.emoji-tile').length > 2000, true);
    assert.equal(resultsView.querySelector('[data-emoji="🫫"]'), null);
    assert.match(document.querySelector('#count').textContent, /^3953 emoji/);
    assert.equal(resultsView.querySelector('#emoji-copy').disabled, false);

    feature.filter('grinning face');
    const selected = () => resultsView.querySelector('.emoji-tile.selected')?.dataset.emoji;
    const arrow = key => new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    assert.equal(selected(), '😀');
    const right = arrow('ArrowRight');
    assert.equal(feature.handleKey(right), true);
    assert.equal(right.defaultPrevented, true);
    assert.equal(selected(), '😃');
    assert.equal(feature.handleKey(arrow('ArrowLeft')), true);
    assert.equal(selected(), '😀');
    assert.equal(feature.handleKey(arrow('ArrowDown')), true);
    assert.notEqual(selected(), '😀');
    const up = arrow('ArrowUp');
    resultsView.querySelector('.emoji-tile.selected').dispatchEvent(up);
    assert.equal(up.defaultPrevented, true);
    assert.equal(selected(), '😀');

    feature.filter('strong');
    const tile = emoji => [...resultsView.querySelectorAll('.emoji-tile')].find(button => button.dataset.emoji === emoji);
    assert.ok(tile('💪'));
    tile('💪').click();
    assert.equal(resultsView.querySelector('#emoji-detail-name').textContent, 'flexed biceps');
    resultsView.querySelector('#emoji-copy').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(messages.at(-1), { type: 'copyEmoji', emoji: '💪' });
    assert.equal(JSON.parse(localStorage.getItem('habibi.emoji.recent.v1'))[0], '💪');
    assert.match(notices.at(-1), /copied/);

    feature.filter('thumbs up');
    tile('👍').click();
    resultsView.querySelector('#emoji-variant-trigger').click();
    assert.equal(resultsView.querySelector('#emoji-variants').hidden, false);
    [...resultsView.querySelectorAll('[data-variant]')].find(button => button.dataset.variant === '👍🏽').click();
    assert.equal(resultsView.querySelector('#emoji-detail-name').textContent, 'thumbs up: medium skin tone');
    const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    assert.equal(feature.handleKey(enter), true);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(messages.at(-1).emoji, '👍🏽');
    assert.equal(JSON.parse(localStorage.getItem('habibi.emoji.recent.v1'))[0], '👍🏽');
  } finally {
    Object.assign(global, previous);
    dom.window.close();
  }
});
