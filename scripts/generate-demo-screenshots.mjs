#!/usr/bin/env node
/** Capture the real UI with sealed fictional data and an isolated browser profile. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { webkit } from 'playwright';
import { installCaptureFixtures } from './demo-capture-fixtures.mjs';
import { startDevServer } from './dev-server.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
// HABIBI_UI_ARTIFACT_DIR writes elsewhere, e.g. to compare without touching docs.
const output = resolve(process.env.HABIBI_UI_ARTIFACT_DIR || join(root, 'docs', 'screenshots'));
const stateRoot = mkdtempSync(join(tmpdir(), 'habibi-demo-capture-'));
const port = 4199;
const url = `http://127.0.0.1:${port}`;
mkdirSync(output, { recursive: true });
execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', join(root, 'tsconfig.json')], {
  stdio: 'inherit',
});
execFileSync('node', [join(root, 'scripts/build-client.mjs')], { cwd: root, stdio: 'inherit' });
let service;
let browser;
try {
  service = await startDevServer({ dataRoot: stateRoot, port }).catch((error) => {
    throw new Error(
      `Screenshot service could not start. Check that port ${port} is free. ${error.message}`,
      { cause: error },
    );
  });
  browser = await webkit.launch();
  const shots = [
    ['daily-briefing', 'briefing'],
    ['launcher-search', 'search'],
    ['preferences', 'preferences'],
    ['ask-habibi', 'ask'],
    ['mail-inbox', 'mail'],
    ['calendar-agenda', 'calendar'],
    ['whatsapp-pairing', 'whatsapp'],
    ['whatsapp-reconnecting', 'whatsapp-reconnecting'],
    ['whodb-workspace', 'whodb'],
    ['whodb-connected', 'whodb-connected'],
    ['whodb-apps', 'whodb-apps'],
    ['whodb-result', 'whodb-result'],
    ['emoji-picker', 'briefing', 'emoji', '.emoji-tile'],
    ['clipboard-history', 'briefing', 'clipboard', '.daily-clipboard-list .daily-item'],
    ['reminders', 'briefing', 'reminders', '.daily-reminder-form'],
    ['focus-timer', 'briefing', 'focus', '.daily-focus-clock'],
    ['focus-session', 'briefing', 'focus', '.daily-focus-clock'],
    ['recent-files', 'briefing', 'recent files', '.daily-workspace-host [data-daily-workspace="recents"]'],
    ['agent-sessions', 'briefing', 'agent sessions', '.agent-session'],
    ['agent-skills', 'briefing', 'skills', '.imported-skill'],
    ['kubernetes-overview', 'briefing', 'kubernetes', '.kubernetes-item'],
    ['notes-workspace', 'briefing', 'notes', '.tiptap'],
    ['notes-formatting', 'briefing', 'notes', '.tiptap'],
    ['teleprompter-editor', 'briefing', 'teleprompter', '#teleprompter-script'],
  ];
  const only = process.argv
    .find((argument) => argument.startsWith('--only='))
    ?.slice(7)
    .split(',');
  if (only?.some((name) => !shots.some((shot) => shot[0] === name)))
    throw new Error('Unknown screenshot name in --only.');
  for (const [name, demo, query, readySelector] of shots.filter(
    ([name]) => !only || only.includes(name),
  )) {
    const context = await browser.newContext({
      viewport: {
        width: 1360,
        height: demo === 'search' ? 760 : demo === 'preferences' ? 800 : 1000,
      },
      deviceScaleFactor: 2,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      locale: 'en-GB',
      timezoneId: 'Europe/London',
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      const unsealed = [];
      page.on('pageerror', (error) => errors.push(error.message));
      // Assets stay local. The application's demo API seals every connector call.
      await page.route('**/*', (route) => {
        const request = new URL(route.request().url());
        if (request.origin !== url || request.pathname.startsWith('/api/')) {
          unsealed.push(request.pathname);
          return route.abort();
        }
        return route.continue();
      });
      await page.goto(`${url}/?demo=${demo}`, { waitUntil: 'networkidle' });
      if (query) {
        await page.evaluate(
          installCaptureFixtures,
          JSON.parse(readFileSync(join(root, 'assets/emoji-catalog.json'), 'utf8')),
        );
        await page.locator('#command-input').fill(query);
        await page.keyboard.press('Enter');
        await page.locator(readySelector).first().waitFor();
        if (name === 'emoji-picker') await page.locator('.emoji-tile[data-emoji="😉"]').click();
        if (name === 'reminders')
          await page
            .getByLabel('Reminder title', { exact: true })
            .fill('Prepare the next design review');
        if (name === 'focus-session') {
          await page.getByLabel('Focus session name').fill('Write the launch story');
          await page.getByRole('button', { name: 'Start session', exact: true }).click();
          await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
        }
        if (name === 'notes-formatting') {
          await page
            .locator('.tiptap p')
            .first()
            .evaluate((paragraph) => {
              paragraph.closest('[contenteditable]').focus();
              const range = document.createRange();
              range.selectNodeContents(paragraph);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              document.dispatchEvent(new Event('selectionchange'));
            });
          await page.getByRole('toolbar', { name: 'Format selection' }).waitFor();
        }
        if (name === 'teleprompter-editor')
          await page
            .locator('#teleprompter-script')
            .fill(
              'Stay present. Speak naturally. Let the next thought arrive.\n\nA clear message starts with one simple idea. Share it at your own pace, and leave a little room to breathe.\n\nThank you for being here.',
            );
      }
      await page.evaluate(async (keepSelection) => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => {})));
        if (!keepSelection) document.activeElement?.blur();
      }, name === 'notes-formatting');
      if (demo !== 'whatsapp-reconnecting')
        await page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll('.loading-state')).some(
              (element) =>
                element.getBoundingClientRect().height > 0 && !element.closest('.hidden'),
            ),
        );
      const sidebar = await page.locator('.rail-destinations [data-workspace-link]').evaluateAll(buttons => buttons.map(button => button.dataset.workspaceLink));
      if (sidebar.join(',') !== 'home,ask,whatsapp,mail,calendar,notes,whodb')
        throw new Error(`Unexpected sidebar destinations in ${name}: ${sidebar.join(',')}`);
      const compactRail = await page.locator('.navigation-rail').evaluate(rail => {
        const buttons = [...rail.querySelectorAll('.rail-destinations .rail-button')];
        const gap = parseFloat(getComputedStyle(rail.querySelector('.rail-destinations')).gap);
        const rows = buttons.map(button => button.getBoundingClientRect());
        const settings = rail.querySelector('.rail-settings').getBoundingClientRect();
        const bottomPadding = parseFloat(getComputedStyle(rail).paddingBottom);
        return rows.slice(1).every((row, index) => Math.abs(row.top - rows[index].bottom - gap) <= 1)
          && Math.abs(rail.getBoundingClientRect().bottom - settings.bottom - bottomPadding) <= 1;
      });
      if (!compactRail) throw new Error(`Sidebar icons must group at the top with Settings at the bottom: ${name}`);
      const bounds = await page.locator('.command-card').boundingBox();
      if (
        !bounds ||
        bounds.x < 0 ||
        bounds.y < 0 ||
        bounds.x + bounds.width > page.viewportSize().width ||
        bounds.y + bounds.height > page.viewportSize().height
      )
        throw new Error(`Clipped launcher in ${demo}`);
      const scrollSelector =
        demo === 'whodb-result'
          ? '#whodb-workspace-body'
          : name === 'agent-skills'
            ? '#results-view'
            : name === 'kubernetes-overview'
              ? '#kubernetes-output'
              : null;
      if (scrollSelector) {
        const extra = await page
          .locator(scrollSelector)
          .evaluate((element) => Math.max(0, element.scrollHeight - element.clientHeight));
        await page.setViewportSize({ width: 1360, height: 1000 + extra + 24 });
        await page.locator('.command-card').evaluate((element) => {
          element.style.height = '100%';
        });
      }
      // Capture just the window. Documentation supplies the backdrop and shadow.
      await page.addStyleTag({
        content:
          'html, body { background: transparent !important; } .command-card { box-shadow: none !important; }',
      });
      if (errors.length || unsealed.length)
        throw new Error(
          `Unsafe or incomplete capture ${name}: ${[...errors, ...unsealed].join(', ')}`,
        );
      await page.locator('.command-card').screenshot({
        path: join(output, `${name}.png`),
        omitBackground: true,
        animations: 'disabled',
        caret: 'hide',
      });
      console.log(`Generated ${join(output, `${name}.png`)}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await service?.stop();
  rmSync(stateRoot, { recursive: true, force: true });
}
