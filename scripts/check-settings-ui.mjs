import assert from 'node:assert/strict';

export async function mockNativeSettings(page) {
  await page.evaluate(() => {
    window.__menuBarFixture = { enabled: true, changes: [] };
    window.webkit = {
      messageHandlers: {
        habibiNative: {
          postMessage(message) {
            queueMicrotask(() => {
              const fixture = window.__menuBarFixture;
              if (message.type === 'menuBarIcon') {
                fixture.enabled = message.enabled;
                fixture.changes.push(message.enabled);
              }
              if (['menuBarIcon', 'menuBarIconState'].includes(message.type))
                window.__habibiMenuBarIconState?.({ enabled: fixture.enabled });
              if (message.type === 'launchAtLoginState')
                window.__habibiLaunchAtLoginState?.({ enabled: false });
            });
          },
        },
      },
    };
  });
}

export async function checkMenuBarSettings(page) {
  const toggle = page.getByRole('switch', { name: 'Show menu bar icon', exact: true });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  await toggle.click();
  await page.waitForFunction(
    () => document.querySelector('#menu-bar-icon-enabled')?.disabled === false,
  );
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.match(await page.locator('#menu-bar-icon-note').textContent(), /Habibi.app/);
  await toggle.click();
  await page.waitForFunction(
    () => document.querySelector('#menu-bar-icon-enabled')?.disabled === false,
  );
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  assert.deepEqual(await page.evaluate(() => window.__menuBarFixture.changes), [false, true]);
}
