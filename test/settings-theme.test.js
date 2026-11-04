const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('Paper & Ink replaces Clidey Ink and migrates saved selections without changing other themes', async () => {
  const dom = new JSDOM('', { url: 'http://127.0.0.1:4173/' });
  global.window = dom.window; global.document = dom.window.document; global.localStorage = dom.window.localStorage;
  try {
    const { createSettingsFeature } = await import('../src/client/features/settings/settings-feature.js');
    const { themeCatalog } = await import('../src/client/features/settings/theme-catalog.js');
    const settings = createSettingsFeature({});
    assert.equal(themeCatalog[0].id, 'paper-ink');
    assert.equal(themeCatalog.some(theme => theme.id === 'deep-ocean' || theme.name === 'Clidey Ink'), false);
    localStorage.setItem('habibi.theme', 'deep-ocean');
    settings.applyTheme();
    assert.equal(document.body.dataset.theme, 'paper-ink');
    assert.equal(localStorage.getItem('habibi.theme'), 'paper-ink');
    settings.applyTheme('midnight-noir');
    assert.equal(localStorage.getItem('habibi.theme'), 'midnight-noir');
    localStorage.removeItem('habibi.theme');
    settings.applyTheme();
    assert.equal(document.body.dataset.theme, 'paper-ink');
  } finally { dom.window.close(); }
});
