import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright';
import { checkNotesUi } from './check-notes-ui.mjs';
import { checkNotesDragUi } from './check-notes-drag-ui.mjs';
import { mockNativeSettings, checkMenuBarSettings } from './check-settings-ui.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'habibi-layout-'));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const server = spawn(process.execPath, ['dist/server.js'], {
  cwd: root,
  env: { ...process.env, HABIBI_PORT: String(port), HABIBI_ROOT: root, HABIBI_DATA_ROOT: data },
  stdio: 'ignore',
});
const url = `http://127.0.0.1:${port}`;
let browser;
const pages = [
  ['home', 'home'],
  ['ask', 'ask'],
  ['settings', 'settings'],
  ['mail', 'mail'],
  ['calendar', 'calendar'],
  ['whatsapp', 'whatsapp'],
  ['notes', 'notes'],
  ['whodb', 'whodb'],
  ['emoji', null, 'emoji'],
  ['teleprompter', null, 'teleprompter'],
  ['kubernetes', null, 'kubernetes'],
  ['agents', null, 'agent sessions'],
  ['skills', null, 'skills'],
];
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(url)).ok;
    } catch {
      /* Wait for the isolated server. */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'UI test server must start');
  browser = await webkit.launch();
  let checked = 0;
  for (const width of [840, 760])
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: { width, height: 580 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((mode) => {
        localStorage.setItem('habibi.color-mode', mode);
        localStorage.setItem('habibi.getting-started.dismissed.v1', 'done');
      }, theme);
      // Fixtures keep screenshots and tests independent of private local sources.
      await page.route('**/api/apps?*', (route) => route.fulfill({ json: { ok: true, apps: [] } }));
      await page.route('**/api/files?*', (route) => route.fulfill({ json: [] }));
      await page.route('**/api/agent-sessions?*', (route) =>
        route.fulfill({ json: { ok: true, sessions: [] } }),
      );
      await page.route('**/api/agent-skills', (route) =>
        route.fulfill({ json: { ok: true, skills: [] } }),
      );
      await page.route('**/api/kubernetes/overview?*', (route) =>
        route.fulfill({
          json: {
            ok: true,
            context: 'test',
            contexts: ['test'],
            namespaces: ['default'],
            namespace: '',
            resources: [],
          },
        }),
      );
      await page.goto(url);
      await page.evaluate(() => {
        document.body.classList.add('native-host');
        document.documentElement.classList.add('native-host');
        window.__habibiUpdateState({ available: true, state: 'available', version: '0.19.0' });
      });
      if (width === 840 && theme === 'dark') {
      const buttons = page.locator('.navigation-rail button');
      for (let index = 0; index < await buttons.count(); index++) {
        const button = buttons.nth(index);
        await button.hover();
        await page.locator('[role="tooltip"]').waitFor();
        assert.equal(await page.locator('[role="tooltip"]').textContent(), await button.getAttribute('aria-label'));
        assert.equal(await button.getAttribute('title'), null, 'avoid duplicate native tooltips');
        await page.locator('#command-input').hover();
        await page.locator('[role="tooltip"]').waitFor({ state: 'hidden' });
      }
      await page.locator('#open-settings').focus();
      await page.locator('[role="tooltip"]').waitFor();
      assert.equal(await page.locator('[role="tooltip"]').textContent(), 'Settings');
      await page.keyboard.press('Escape');
      await page.locator('[role="tooltip"]').waitFor({ state: 'hidden' });
      await page.locator('[data-workspace-link="notes"]').click();
      await page.locator('.notes-workspace').waitFor();
    }
    for (const [name, rail, query] of pages.filter(([name]) => !process.env.HABIBI_UI_WORKSPACE || name === process.env.HABIBI_UI_WORKSPACE)) {
        await page.locator('[data-workspace-link="home"]').click();
        if (name === 'settings') await mockNativeSettings(page);
        if (rail) await page.locator(`[data-workspace-link="${rail}"]`).click();
        else {
          await page.locator('#command-input').fill(query);
          await page.keyboard.press('Enter');
        }
        await page.waitForFunction(
          (expected) => document.body.dataset.workspace === expected,
          name,
        );
        await page.waitForTimeout(100);
        try {
          const layout = await page.evaluate(() => {
            const main = document.querySelector(
              '#default-view:not(.hidden), #results-view:not(.hidden)',
            );
            const footer = document.querySelector('.keyboard-footer');
            const bounds = footer.getBoundingClientRect();
            return {
              overflow: main.scrollWidth > main.clientWidth + 2,
              clipped: [...main.querySelectorAll('button')]
                .filter(
                  (button) => button.offsetHeight && button.scrollHeight > button.clientHeight + 4,
                )
                .map((button) => button.id || button.textContent.trim().slice(0, 40)),
              footerOverflow: footer.scrollWidth > footer.clientWidth + 2,
              footerFits: [...footer.querySelectorAll('#update-available, #app-menu-trigger')]
                .filter((button) => button.offsetHeight)
                .every((button) => {
                  const rect = button.getBoundingClientRect();
                  return (
                    rect.top >= bounds.top &&
                    rect.bottom <= bounds.bottom &&
                    rect.right <= bounds.right
                  );
                }),
              catalogMask: getComputedStyle(
                document.querySelector('#app-menu-trigger [data-slot="icon"]'),
              ).maskImage,
              missingIconMasks: [...document.querySelectorAll('svg[data-ux-glyph]')].filter(
                (icon) => getComputedStyle(icon).maskImage === 'none',
              ).length,
              iconHeight: document
                .querySelector('#app-menu-trigger [data-slot="icon"]')
                .getBoundingClientRect().height,
              iconBackground: getComputedStyle(
                document.querySelector('#app-menu-trigger [data-slot="icon"]'),
              ).backgroundColor,
            };
          });
          assert.equal(layout.overflow, false, `${name}: horizontal overflow`);
          assert.deepEqual(layout.clipped, [], `${name}: clipped controls`);
          assert.equal(layout.footerOverflow, false, `${name}: footer overflow`);
          assert.equal(layout.footerFits, true, `${name}: footer controls must fit`);
          assert.ok(
            layout.catalogMask.includes('data:image/svg+xml'),
            `${name}: catalog mask must render`,
          );
          assert.equal(
            layout.missingIconMasks,
            0,
            `${name}: hydrated icons must render from catalog masks`,
          );
          assert.ok(layout.iconHeight <= 20, `${name}: menu icon must stay compact`);
          assert.equal(
            layout.iconBackground,
            'rgba(0, 0, 0, 0)',
            `${name}: action icon must have no filled tile`,
          );
          assert.deepEqual(errors, [], `${name}: browser errors`);
          if (name === 'settings' && width === 840 && theme === 'dark') await checkMenuBarSettings(page);
          if (name === 'settings') await page.evaluate(() => { delete window.webkit; });
          if (name === 'notes' && width === 840 && theme === 'dark') { await checkNotesUi(page); await checkNotesDragUi(page); }
          checked++;
        } catch (error) {
          const screenshot = path.join(os.tmpdir(), `habibi-layout-${name}-${theme}-${width}.png`);
          await page.screenshot({ path: screenshot });
          throw new Error(`${error.message}\nScreenshot: ${screenshot}`, { cause: error });
        }
      }
      await page.close();
    }
  console.log(`WebKit layout check passed: ${checked} workspace/theme/size combinations.`);
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const closed = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await closed;
  }
  await fs.rm(data, { recursive: true, force: true });
}
