import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { webkit } from 'playwright';
const directory = path.resolve('docs/dist');
const artifacts = path.join(os.tmpdir(), 'habibi-interactive-docs');
await fs.mkdir(artifacts, { recursive: true });
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webm': 'video/webm',
};
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith('/habibi/')) throw new Error('Invalid prefix');
    let file = path.resolve(directory, decodeURIComponent(url.pathname.slice('/habibi/'.length)));
    if (file !== directory && !file.startsWith(directory + path.sep))
      throw new Error('Invalid path');
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
    response.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
    });
    response.end(await fs.readFile(file));
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let checked = 0;
try {
  browser = await webkit.launch();
  for (const colorScheme of ['light', 'dark'])
    for (const width of [1200, 760, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme,
        reducedMotion: 'reduce',
      });
      const errors = [];
      const apiCalls = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/api/')) apiCalls.push(url.pathname);
        return url.origin === origin ? route.continue() : route.abort();
      });
      async function open(slug, name) {
        const html = await (await fetch(origin + '/habibi/guides/' + slug + '/')).text();
        assert.ok(html.includes(name), 'Interactive example must be present in prerendered HTML');
        await page.goto(origin + '/habibi/guides/' + slug + '/');
        return page.getByRole('region', { name, exact: true });
      }
      async function fits(demo) {
        assert.ok(
          await demo.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          `${width}px demo must not overflow`,
        );
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          `${width}px page must not overflow`,
        );
      }
      async function task(demo, label) {
        await demo.getByRole('combobox', { name: 'Demo file task' }).click();
        await page.getByRole('option', { name: label, exact: true }).click();
      }
      const demo = await open('ai-file-tools', 'Interactive file workflow');
      await demo.getByRole('button', { name: 'Prepare demo plan' }).click();
      await demo.getByRole('checkbox', { name: 'Select scan-02.pdf', exact: true }).click();
      await demo.getByRole('button', { name: 'Review 2 changes', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      const folder = demo.locator('[aria-label="Demo source folder"]');
      assert.ok((await folder.textContent()).includes('scan-01.pdf'));
      assert.ok(!(await folder.textContent()).includes('2026-11-06'));
      await demo.getByRole('button', { name: 'Review 2 changes', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Apply selected changes', exact: true })
        .click();
      assert.ok((await folder.textContent()).includes('2026-11-06-demo-cafe.pdf'));
      assert.ok(
        (await folder.textContent()).includes('scan-02.pdf'),
        'Unchecked file must be unchanged',
      );
      await demo.getByRole('button', { name: 'Undo these changes' }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Undo changes', exact: true })
        .click();
      assert.ok((await folder.textContent()).includes('scan-01.pdf'));
      await task(demo, 'Compress an image');
      await demo.getByRole('button', { name: 'Prepare demo plan' }).click();
      assert.ok((await demo.textContent()).includes('Not processed. Requires confirmation.'));
      await demo.getByRole('button', { name: 'Review output preview' }).click();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.ok((await demo.textContent()).includes('Not processed. Requires confirmation.'));
      await demo.getByRole('button', { name: 'Review output preview' }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Generate previews', exact: true })
        .click();
      assert.ok((await demo.textContent()).includes('2.4 MB → 420 KB'));
      assert.ok(
        !(await folder.textContent()).includes('photo-small.jpg'),
        'Generating previews must not save outputs',
      );
      await demo.getByRole('button', { name: 'Review 1 change', exact: true }).click();
      assert.ok(
        await page.getByRole('dialog').evaluate((el) => el.contains(document.activeElement)),
        'Dialog must receive focus',
      );
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Apply selected changes', exact: true })
        .click();
      assert.ok((await folder.textContent()).includes('photo-small.jpg'));
      await task(demo, 'Review duplicate cleanup');
      assert.equal(
        await demo.getByRole('button', { name: 'Prepare demo plan' }).isDisabled(),
        true,
      );
      await demo.getByRole('checkbox', { name: /Allow cleanup/ }).click();
      await demo.getByRole('button', { name: 'Prepare demo plan' }).click();
      assert.ok((await folder.textContent()).includes('invoice-copy.pdf'));
      await demo.getByRole('button', { name: 'Review 1 change' }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Apply selected changes' })
        .click();
      assert.ok((await folder.textContent()).includes('original kept; copy moved to Trash'));
      await demo.getByRole('button', { name: 'Reset demo' }).click();
      await fits(demo);
      await page.screenshot({ path: path.join(artifacts, `files-${colorScheme}-${width}.png`) });
      const timer = await open('focus', 'Interactive timer review');
      await timer.getByRole('textbox', { name: 'Demo session name' }).fill('Read the proposal');
      assert.ok((await timer.getByRole('status').textContent()).includes('Nothing has started'));
      await timer.getByRole('button', { name: 'Start demo session' }).click();
      assert.ok(
        (await timer.getByRole('status').textContent()).includes('running: Read the proposal'),
      );
      await timer.getByRole('button', { name: 'Pause demo' }).click();
      assert.ok((await timer.getByRole('status').textContent()).includes('paused'));
      await timer.getByRole('button', { name: 'Resume demo' }).click();
      await fits(timer);
      const reminder = await open('reminders', 'Interactive reminder review');
      await reminder.getByRole('textbox', { name: 'Demo reminder title' }).fill('Call Demo Studio');
      assert.ok((await reminder.getByRole('status').textContent()).includes('Nothing has started'));
      await reminder.getByRole('button', { name: 'Confirm demo reminder' }).click();
      assert.ok((await reminder.getByRole('status').textContent()).includes('Call Demo Studio'));
      await fits(reminder);
      assert.deepEqual(errors, []);
      assert.deepEqual(apiCalls, [], 'Documentation demos must never call Habibi or provider APIs');
      checked += 3;
      await page.close();
    }
  console.log(
    `Interactive docs passed: ${checked} page/theme/size cases; selection, cancel, Escape, focus, explicit preview/apply, Undo, cleanup opt-in, edited timer/reminder confirmation; no API requests. Screenshots: ${artifacts}`,
  );
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png') });
    console.error(
      await page
        .getByRole('dialog')
        .evaluateAll((elements) =>
          elements.map((el) => ({
            state: el.getAttribute('data-state'),
            text: el.textContent,
            focused: el.contains(document.activeElement),
          })),
        ),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
