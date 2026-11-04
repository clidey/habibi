import { webkit } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'habibi-daily-ui-'));
const fixtureDir = await fs.mkdtemp(process.cwd() + '/build/daily-ui-fixture.');
const file = fixtureDir + '/Demo plan.txt';
const image = fixtureDir + '/Copied image.png';
await fs.writeFile(
  image,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=',
    'base64',
  ),
);
await fs.writeFile(file, 'A fictional attachment.');
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
let browser;
const server = spawn(process.execPath, ['dist/server.js'], {
  env: {
    ...process.env,
    HABIBI_ROOT: process.cwd(),
    HABIBI_DATA_ROOT: data,
    HABIBI_PORT: String(port),
  },
  stdio: 'ignore',
});
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  await fetch(origin + '/api/recent-files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'record', path: file }),
  });
  browser = await webkit.launch();
  const page = await browser.newPage({
    viewport: { width: 1040, height: 760 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let modelCalls = 0;
  await page.addInitScript(() => {
    localStorage.setItem('habibi.getting-started.dismissed.v1', 'done');
    window.dailyCalls = [];
    window.fakeClip = {
      ok: true,
      enabled: false,
      items: [
        {
          id: 'clip1',
          kind: 'text',
          name: 'A fictional copied thought',
          text: 'A fictional copied thought',
          source: 'Demo editor',
          createdAt: new Date().toISOString(),
          pinned: false,
        },
      ],
    };
    window.fakeReminders = {
      ok: true,
      access: false,
      items: [],
      lists: [{ id: 'list1', name: 'Personal' }],
      defaultList: 'list1',
    };
    window.fakeFocus = {
      ok: true,
      state: 'idle',
      duration: 1500,
      remaining: 1500,
      label: 'Focus',
      visible: false,
    };
    window.webkit = {
      messageHandlers: {
        habibiNative: {
          postMessage(m) {
            window.dailyCalls.push(m);
            if (m.type !== 'dailyUtility') return;
            let result = { ok: true };
            if (m.action.startsWith('clipboard.')) {
              if (m.action === 'clipboard.enable') fakeClip.enabled = m.enabled;
              if (m.action === 'clipboard.pin') fakeClip.items[0].pinned = m.pinned;
              if (m.action === 'clipboard.remove')
                fakeClip.items = m.id ? fakeClip.items.filter((x) => x.id !== m.id) : [];
              result = { ...fakeClip };
            }
            if (m.action.startsWith('reminders.')) {
              if (m.action === 'reminders.access') fakeReminders.access = true;
              if (m.action === 'reminders.create')
                fakeReminders.items.push({
                  id: 'r1',
                  title: m.title,
                  due: m.due,
                  list: 'Personal',
                  completed: false,
                });
              if (m.action === 'reminders.complete')
                fakeReminders.items = fakeReminders.items.filter((x) => x.id !== m.id);
              result = { ...fakeReminders };
            }
            if (m.action === 'focus') {
              const v = m.value || {};
              if (v.action === 'start')
                Object.assign(fakeFocus, {
                  state: 'running',
                  remaining: v.seconds,
                  duration: v.seconds,
                  label: v.label,
                  visible: true,
                });
              if (v.action === 'pause') fakeFocus.state = 'paused';
              if (v.action === 'resume') fakeFocus.state = 'running';
              if (v.action === 'reset') fakeFocus.state = 'idle';
              if (v.action === 'hide') fakeFocus.visible = false;
              if (v.action === 'show') fakeFocus.visible = true;
              result = { ...fakeFocus };
            }
            queueMicrotask(() =>
              window.__habibiDailyResult?.({ ...result, requestId: m.requestId }),
            );
          },
        },
      },
    };
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/recent-files' || url.pathname === '/api/file')
      return route.continue();
    if (url.pathname === '/api/llm/chat') modelCalls++;
    const account = {
      id: 'demo-account',
      provider: 'gmail',
      email: 'demo@example.com',
      label: 'Demo mail',
      connected: true,
    };
    let json = {
      ok: true,
      accounts: [],
      providers: [],
      apps: [],
      files: [],
      events: [],
      chats: [],
      messages: [],
      sessions: [],
      skills: [],
      available: false,
      configured: false,
    };
    if (url.pathname === '/api/mail/status')
      json = { ok: true, accounts: [account], providers: [] };
    if (url.pathname === '/api/mail/threads') json = { ok: true, threads: [] };
    if (url.pathname === '/api/llm/status') json = { ok: true, configured: false, providers: [] };
    await route.fulfill({ json });
  });
  await page.goto(origin);
  await page.evaluate(() => {
    document.body.classList.add('native-host', 'dark');
    document.body.classList.remove('light');
    document.body.dataset.colorMode = 'dark';
  });
  async function open(name) {
    await page.locator('[data-workspace-link=home]').click();
    await page.locator('#command-input').fill(name);
    await page.keyboard.press('Enter');
    await page.locator('[data-daily-workspace]').waitFor();
    await page.waitForFunction(
      () =>
        !document
          .querySelector('.daily-workspace-host .daily-empty')
          ?.textContent.includes('Opening'),
    );
  }
  await open('clipboard');
  assert.equal(await page.getByRole('tablist', { name: 'Daily tools' }).count(), 0);
  for (const name of ['clipboard', 'reminders', 'focus', 'recents']) {
    await page.locator(`[data-workspace-link=${name}]`).click();
    await page.locator(`[data-daily-workspace=${name}]`).waitFor();
  }
  await open('clipboard');
  await page.getByRole('switch', { name: 'Enable clipboard history' }).waitFor();
  assert.equal(
    await page.locator('#command-input').evaluate((input) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          types: ['text/plain'],
          items: [],
          files: [],
          getData: () =>
            'A long clipboard search that should stay inside clipboard history rather than becoming a message.',
        },
      });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    false,
  );

  assert.equal(
    await page.evaluate(() => dailyCalls.some((c) => c.action === 'clipboard.enable')),
    false,
  );
  await page.getByRole('switch', { name: 'Enable clipboard history' }).click();
  await page.getByText('Clipboard history is on').waitFor();
  await page.getByRole('button', { name: /A fictional copied thought/ }).click();
  assert.ok(await page.evaluate(() => dailyCalls.some((c) => c.action === 'clipboard.copy')));
  await page.locator('#toast.show').waitFor();
  assert.ok(
    await page.locator('#toast').evaluate((toast) => {
      const rect = toast.getBoundingClientRect();
      return (
        rect.bottom <= document.querySelector('.keyboard-footer').getBoundingClientRect().top - 8 &&
        rect.height >= 36
      );
    }),
    'Clipboard feedback must sit above the footer',
  );
  await page.getByRole('button', { name: 'Pin clipboard item' }).click();
  await page.getByRole('button', { name: 'Unpin clipboard item' }).waitFor();
  await page.screenshot({ path: path.join(os.tmpdir(), 'habibi-daily-clipboard.png') });
  await page.getByRole('button', { name: 'Clear history', exact: true }).click();
  assert.equal(await page.evaluate(() => fakeClip.items.length), 1);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate((image) => {
    fakeClip.items.push({
      id: 'image1',
      kind: 'image',
      name: 'Copied image',
      path: image,
      previewPath: image,
      source: 'Demo editor',
      createdAt: new Date().toISOString(),
      pinned: false,
    });
    window.__habibiDailyChanged?.('clipboard');
  }, image);
  await open('clipboard');
  await page.locator('.daily-clip-image').waitFor();
  await page.waitForFunction(() => document.querySelector('.daily-clip-image')?.naturalWidth > 0);
  await page.screenshot({ path: path.join(os.tmpdir(), 'habibi-daily-clipboard.png') });
  await open('Tomorrow remind me at 12pm to pack lunch');
  const connect = page.getByRole('button', { name: 'Connect Apple Reminders' });
  for (const mode of ['dark', 'light']) {
    await page.evaluate((mode) => {
      document.body.dataset.colorMode = mode;
      document.body.classList.toggle('dark', mode === 'dark');
      document.body.classList.toggle('light', mode === 'light');
    }, mode);
    assert.ok(
      await connect.evaluate(
        (button) => getComputedStyle(button).color !== getComputedStyle(button.parentElement).color,
      ),
      'Primary button must not inherit muted text',
    );
  }
  await page.screenshot({ path: path.join(os.tmpdir(), 'habibi-daily-reminders-connect.png') });
  await page.getByRole('button', { name: 'Connect Apple Reminders' }).click();
  await page.getByRole('textbox', { name: 'Reminder title' }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'Reminder title' }).inputValue(),
    'pack lunch',
  );
  assert.equal(
    await page.evaluate(() => dailyCalls.some((c) => c.action === 'reminders.create')),
    false,
  );
  await page.getByRole('button', { name: 'Create reminder', exact: true }).click();
  await page.getByRole('button', { name: 'Complete pack lunch' }).waitFor();
  const created = await page.evaluate(() =>
    dailyCalls.find((c) => c.action === 'reminders.create'),
  );
  assert.equal(created.approved, true);
  assert.ok(created.due);
  await page.screenshot({ path: path.join(os.tmpdir(), 'habibi-daily-reminders.png') });
  await page.getByRole('button', { name: 'Complete pack lunch' }).click();
  assert.equal(await page.evaluate(() => fakeReminders.items.length), 1);
  await page.getByRole('dialog').getByRole('button', { name: 'Mark complete' }).click();
  await page.getByText('You’re all caught up.').waitFor();
  await open('focus');
  await page.getByRole('button', { name: 'Start session' }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('button', { name: 'Hide near the notch' }).click();
  assert.equal(await page.evaluate(() => fakeFocus.visible), false);
  await page.screenshot({ path: path.join(os.tmpdir(), 'habibi-daily-focus.png') });
  await open('recent files');
  await page.getByRole('button', { name: /Demo plan.txt.*Demo plan/ }).waitFor();
  await page.screenshot({ path: path.join(os.tmpdir(), 'habibi-daily-recents.png') });
  await page.getByRole('button', { name: 'Pin Demo plan.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Unpin Demo plan.txt', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Recent file attachments', exact: true }).click();
  const tray = page.locator('.recent-files-tray');
  await tray.waitFor();
  await tray.getByRole('button', { name: 'Attach Demo plan.txt' }).click();
  await page.locator('#habibi-attachments').getByText('Demo plan.txt').waitFor();
  assert.equal(modelCalls, 0);
  for (const mode of ['dark', 'light'])
    for (const size of [
      { width: 1040, height: 760 },
      { width: 760, height: 580 },
    ])
      for (const name of ['clipboard', 'reminders', 'focus', 'recent files']) {
        await page.setViewportSize(size);
        await page.evaluate((mode) => {
          document.body.classList.toggle('dark', mode === 'dark');
          document.body.classList.toggle('light', mode === 'light');
          document.body.dataset.colorMode = mode;
        }, mode);
        await open(name);
        const bounds = await page.locator('.daily-workspace').evaluate((el) => ({
          width: el.clientWidth,
          scroll: el.scrollWidth,
          bottom: el.getBoundingClientRect().bottom,
          footer: document.querySelector('.keyboard-footer').getBoundingClientRect().top,
        }));
        assert.ok(bounds.scroll <= bounds.width + 1, JSON.stringify({ name, mode, size, bounds }));
        assert.ok(bounds.bottom <= bounds.footer + 1);
      }
  const overlay = await browser.newPage({
    viewport: { width: 370, height: 86 },
    deviceScaleFactor: 2,
  });
  await overlay.addInitScript(() => {
    window.overlayActions = [];
    window.webkit = {
      messageHandlers: {
        focusOverlay: {
          postMessage(value) {
            overlayActions.push(value.action);
            if (value.action === 'ready')
              queueMicrotask(() =>
                window.__habibiFocusState?.({
                  state: 'running',
                  remaining: 1259,
                  label: 'Focus',
                  inset: 32,
                }),
              );
          },
        },
      },
    };
  });
  await overlay.goto(pathToFileURL(path.join(root, 'assets/focus-overlay.html')).href);
  await overlay.getByRole('timer').waitFor();
  assert.equal(await overlay.getByRole('timer').textContent(), '20:59');
  await overlay.getByRole('button', { name: 'Pause timer' }).click();
  assert.ok(await overlay.evaluate(() => overlayActions.includes('pause')));
  await overlay.screenshot({ path: path.join(os.tmpdir(), 'habibi-focus-notch.png') });
  await overlay.close();
  assert.deepEqual(errors, []);
  console.log(
    'Daily UI passed: clipboard opt-in/copy/pin, reviewed reminders, focus controls, recent pin/attachment, no model uploads, all four utilities at two sizes in both themes.',
  );
} finally {
  await browser?.close();
  server.kill();
  await fs.rm(data, { recursive: true, force: true });
  await fs.rm(fixtureDir, { recursive: true, force: true });
}
