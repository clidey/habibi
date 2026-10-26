#!/usr/bin/env node
/** Capture the real UI with sealed fictional data and an isolated browser profile. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(new URL('..', import.meta.url).pathname);
const output = join(root, 'docs', 'screenshots');
const stateRoot = mkdtempSync(join(tmpdir(), 'habibi-demo-capture-'));
const port = 4199;
const url = `http://127.0.0.1:${port}`;
mkdirSync(output, { recursive: true });
execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', join(root, 'tsconfig.json')], { stdio: 'inherit' });
execFileSync('node', [join(root, 'scripts/build-client.mjs')], { cwd: root, stdio: 'inherit' });
const service = spawn('node', [join(root, 'dist/server.js')], {
  cwd: root,
  env: { ...process.env, HABIBI_ROOT: root, HABIBI_DATA_ROOT: stateRoot, HABIBI_PORT: String(port) },
  stdio: 'ignore',
});
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (service.exitCode !== null) throw new Error('Screenshot service could not start. Check that port 4199 is free.');
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* wait for local service */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Screenshot service did not become ready.');
  browser = await chromium.launch();
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
  ];
  for (const [name, demo] of shots) {
    const context = await browser.newContext({
      viewport: { width: 1360, height: demo === 'search' ? 760 : demo === 'preferences' ? 800 : 1000 }, deviceScaleFactor: 2,
      colorScheme: 'dark', reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'Europe/London',
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      // Assets stay local. The application's demo API seals every connector call.
      await page.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
      await page.goto(`${url}/?demo=${demo}`, { waitUntil: 'networkidle' });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images, image => image.decode().catch(() => {})));
        document.activeElement?.blur();
      });
      if (demo !== 'whatsapp-reconnecting') await page.waitForFunction(() => !Array.from(document.querySelectorAll('.loading-state')).some(element => element.getBoundingClientRect().height > 0 && !element.closest('.hidden')));
      const bounds = await page.locator('.command-card').boundingBox();
      if (!bounds || bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > page.viewportSize().width || bounds.y + bounds.height > page.viewportSize().height) throw new Error(`Clipped launcher in ${demo}`);
      if (demo === 'whodb-result') {
        const extra = await page.locator('#whodb-workspace-body').evaluate(element => element.scrollHeight - element.clientHeight);
        await page.setViewportSize({ width: 1360, height: 1000 + extra + 24 });
        await page.locator('.command-card').evaluate(element => { element.style.height = '100%'; });
      }
      await page.screenshot({ path: join(output, `${name}.png`), animations: 'disabled', caret: 'hide' });
      console.log(`Generated docs/screenshots/${name}.png`);
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  service.kill();
  rmSync(stateRoot, { recursive: true, force: true });
}
