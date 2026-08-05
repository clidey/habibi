const test = require('node:test');
const assert = require('node:assert/strict');

// analytics.js reads localStorage directly (not window.localStorage), so a
// minimal in-memory stub is enough — no DOM needed for this module.
function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
    clear: () => store.clear(),
  };
}

test('analytics is enabled by default for a user who has never visited Settings', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const { analyticsEnabled } = await import('../src/client/core/analytics.js?default-on');
  assert.equal(analyticsEnabled(), true);
});

test('an explicit opt-out from Settings is honored', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const { analyticsEnabled, setAnalyticsEnabled } = await import('../src/client/core/analytics.js?opt-out');
  setAnalyticsEnabled(false);
  assert.equal(analyticsEnabled(), false);
});

test('re-enabling after an opt-out restores tracking', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const { analyticsEnabled, setAnalyticsEnabled } = await import('../src/client/core/analytics.js?re-enable');
  setAnalyticsEnabled(false);
  assert.equal(analyticsEnabled(), false);
  setAnalyticsEnabled(true);
  assert.equal(analyticsEnabled(), true);
});

test('track() sends nothing once the user has opted out, and never throws on a failed request', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const { track, setAnalyticsEnabled } = await import('../src/client/core/analytics.js?track-gate');
  setAnalyticsEnabled(false);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok:true }; };
  track('habibi.launcher.opened', {});
  assert.equal(calls, 0);

  setAnalyticsEnabled(true);
  globalThis.fetch = async () => { calls += 1; throw new Error('network down'); };
  await assert.doesNotReject(async () => track('habibi.launcher.opened', {}));
});
