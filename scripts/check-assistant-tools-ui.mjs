import { webkit } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createFileToolsService } = require('../dist/src/server/services/file-tools/service.js');
const { createApprovalService } = require('../dist/src/core/approval-service.js');
const { normalizeDailyPlan } = require('../dist/src/server/services/file-tools/daily-plan.js');
const root = process.cwd();
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'habibi-assistant-ui-'));
const screenshots = process.env.HABIBI_UI_ARTIFACT_DIR || path.join(root, 'docs/screenshots');
await fs.mkdir(screenshots, { recursive: true });
const documents = path.join(temporary, 'Demo Inbox');
await fs.mkdir(documents);
await fs.writeFile(path.join(documents, 'scan-01.txt'), 'Demo Cafe, 2026-11-06, GBP 12.50');
await fs.writeFile(path.join(documents, 'scan-02.txt'), 'Demo Studio, 2026-11-05, GBP 40.00');
let providerConfigured = true;
let nativeConversions = 0;
let browserOpens = 0;
const model = {
  async complete(input) {
    const evidence = JSON.parse(input.messages[0].text);
    if (/compress/i.test(evidence.request))
      return {
        ok: true,
        provider: 'demo',
        model: 'fictional fixtures',
        text: JSON.stringify({
          summary: 'Compress the selected image into a new JPEG copy.',
          changes: [
            {
              kind: 'image',
              sources: [evidence.files.find((file) => /png$/.test(file.name)).id],
              destination: 'smaller.jpg',
              format: 'jpeg',
              quality: 60,
            },
          ],
          findings: [],
        }),
      };
    return {
      ok: true,
      provider: 'demo',
      model: 'fictional fixtures',
      text: JSON.stringify({
        summary:
          'Two receipts can use readable vendor and date names. Review both changes before applying.',
        changes: evidence.files.map((file, i) => ({
          kind: 'move',
          sources: [file.id],
          destination: i === 0 ? '2026-11-06-demo-cafe.txt' : '2026-11-05-demo-studio.txt',
          reason: 'Date and vendor from the selected receipt.',
        })),
        findings: [],
      }),
    };
  },
};
const service = createFileToolsService({
  root: temporary,
  llm: model,
  native: async (request) => {
    assert.equal(request.action, 'image');
    nativeConversions++;
    await fs.writeFile(request.destination, Buffer.from('/9j/2Q==', 'base64'));
    return { ok: true };
  },
});
const approvals = createApprovalService();
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server.js'], {
  env: {
    ...process.env,
    HABIBI_ROOT: root,
    HABIBI_DATA_ROOT: temporary,
    HABIBI_PORT: String(port),
  },
  stdio: 'ignore',
});
let browser;
let video;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await webkit.launch();
  const context = await browser.newContext({
    viewport: { width: 1100, height: 860 },
    deviceScaleFactor: 1,
    recordVideo: { dir: path.join(temporary, 'video'), size: { width: 1100, height: 860 } },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  video = page.video();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('habibi.getting-started.dismissed.v1', 'done');
    window.nativeCalls = [];
    let focus = {
      ok: true,
      state: 'idle',
      duration: 1500,
      remaining: 1500,
      label: 'Focus',
      visible: false,
    };
    let reminders = {
      ok: true,
      access: true,
      items: [],
      lists: [{ id: 'list1', name: 'Personal' }],
      defaultList: 'list1',
    };
    let clipboard = { ok: true, enabled: false, items: [] };
    window.webkit = {
      messageHandlers: {
        habibiNative: {
          postMessage(value) {
            window.nativeCalls.push(value);
            if (value.type !== 'dailyUtility') return;
            let result = { ok: true };
            if (value.action === 'focus') {
              if (value.value?.action === 'start')
                focus = {
                  ...focus,
                  state: 'running',
                  remaining: value.value.seconds,
                  duration: value.value.seconds,
                  label: value.value.label,
                };
              if (value.value?.action === 'pause') focus.state = 'paused';
              if (value.value?.action === 'resume') focus.state = 'running';
              result = { ...focus };
            }
            if (value.action.startsWith('reminders.')) {
              if (value.action === 'reminders.create')
                reminders.items.push({
                  id: 'r1',
                  title: value.title,
                  list: 'Personal',
                  due: value.due,
                });
              result = { ...reminders };
            }
            if (value.action.startsWith('clipboard.')) {
              if (value.action === 'clipboard.enable') clipboard.enabled = value.enabled;
              result = { ...clipboard };
            }
            queueMicrotask(() =>
              window.__habibiDailyResult?.({ ...result, requestId: value.requestId }),
            );
          },
        },
      },
    };
  });
  const demoPath = '/Users/demo/Downloads/Demo Inbox';
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON() || {};
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
      configured: false,
    };
    try {
      if (url.pathname === '/api/llm/status')
        json = { ok: true, configured: providerConfigured, provider: 'openai', model: 'gpt-6-luna' };
      if (url.pathname === '/api/file-tools/paths')
        json = { ok: true, items: [{ path: demoPath, name: 'Demo Inbox', directory: true }] };
      if (url.pathname === '/api/file-tools/grant') {
        const grant = await service.grant(documents);
        json = { ok: true, grant: { ...grant, path: demoPath } };
      }
      if (url.pathname === '/api/file-tools/prepare')
        json = { ok: true, ...(await service.prepare(body)) };
      if (url.pathname === '/api/approvals')
        json = { ok: true, approval: approvals.issue(body.action, body.payload) };
      if (url.pathname === '/api/agent/route')
        json = { ok: true, action: 'open_url', url: 'https://example.test/' };
      if (url.pathname === '/api/browser/open') {
        browserOpens++;
        json = { ok: true };
      }
      if (url.pathname === '/api/file-tools/preview') {
        const payload = { planId: body.planId, selected: body.selected };
        assert.ok(
          approvals.consume({ token: body.approvalToken, action: 'file-tools.preview', payload }),
        );
        json = { ok: true, ...(await service.preview(body.planId, body.selected)) };
      }
      if (url.pathname === '/api/file-tools/apply') {
        const payload = {
          planId: body.planId,
          selected: body.selected,
          cleanupAcknowledged: body.cleanupAcknowledged === true,
        };
        assert.ok(
          approvals.consume({ token: body.approvalToken, action: 'file-tools.apply', payload }),
        );
        json = {
          ok: true,
          ...(await service.apply(body.planId, body.selected, body.cleanupAcknowledged)),
        };
      }
      if (url.pathname === '/api/file-tools/undo') {
        assert.ok(
          approvals.consume({
            token: body.approvalToken,
            action: 'file-tools.undo',
            payload: { planId: body.planId },
          }),
        );
        json = await service.undo(body.planId);
      }
      if (url.pathname === '/api/file-tools/daily')
        json = {
          ok: true,
          plan: normalizeDailyPlan(
            /remind/i.test(body.request)
              ? {
                  kind: 'reminder',
                  action: 'create',
                  title: 'Pack lunch',
                  due: '2026-11-07T12:00:00+05:30',
                }
              : /clipboard/i.test(body.request)
                ? { kind: 'clipboard' }
                : /recent/i.test(body.request)
                  ? { kind: 'recents' }
                  : { kind: 'timer', action: 'start', seconds: 1020, label: 'Write proposal' },
          ),
        };
      if (url.pathname === '/api/recent-files') json = { ok: true, items: [] };
    } catch (error) {
      json = { ok: false, error: error.message };
    }
    await route.fulfill({ json });
  });
  await page.goto(origin);
  await page.evaluate(() => {
    document.body.classList.add('native-host', 'dark');
    document.body.classList.remove('light');
    document.body.dataset.colorMode = 'dark';
  });
  assert.equal(await page.locator('[data-workspace-link=focus]').count(), 0);
  assert.equal(await page.locator('[data-workspace-link=reminders]').count(), 0);
  assert.deepEqual(await page.locator('.rail-destinations [data-workspace-link]').evaluateAll(buttons => buttons.map(button => button.dataset.workspaceLink)), ['home', 'ask', 'whatsapp', 'mail', 'calendar', 'notes', 'whodb']);
  providerConfigured = false;
  const utilityRequests = [];
  page.on('request', (request) => {
    if (/\/api\/(?:agent\/route|llm\/chat)/.test(request.url())) utilityRequests.push(request.url());
  });
  for (const [query, workspace, keyboard] of [
    ['Clip', 'clipboard', false],
    ['Clipboard history', 'clipboard', true],
    ['Reminders', 'reminders', false],
    ['Start a 10 minute focus timer', 'focus', true],
    ['Recent files', 'recents', false],
  ]) {
    await page.locator('[data-workspace-link=home]').click();
    const input = page.locator('#command-input');
    await input.fill(query);
    await input.dispatchEvent('input');
    const result = page.locator(`.best-matches-region .result[data-type="${workspace}"]`);
    await result.waitFor();
    if (keyboard) await input.press('Enter');
    else await result.click();
    await page.locator(`.daily-workspace-host [data-daily-workspace="${workspace}"]`).waitFor();
    assert.equal(await page.locator('.habibi-chat').count(), 0);
    assert.equal(await page.locator('body').getAttribute('data-workspace'), workspace);
    if (workspace === 'focus') assert.equal(await page.getByRole('spinbutton', {name: 'Focus duration in minutes'}).inputValue(), '10');
    if (workspace === 'clipboard') {
      assert.equal(await input.getAttribute('placeholder'), 'Search clipboard history…');
      await page.getByRole('switch', {name: 'Enable clipboard history'}).waitFor();
      await page.screenshot({path: path.join(screenshots, 'clipboard-direct-navigation.png')});
    }
  }
  assert.deepEqual(utilityRequests, [], 'Explicit utility shortcuts never invoke an AI route or chat completion');
  assert.equal(await page.evaluate(() => nativeCalls.some(call => call.action === 'reminders.create' || (call.action === 'focus' && call.value?.action === 'start'))), false);
  for (const [label, workspace] of [['Clipboard', 'clipboard'], ['Reminders', 'reminders'], ['Focus timer', 'focus'], ['Recent files', 'recents']]) {
    await page.locator('[data-workspace-link=ask]').click();
    await page.getByRole('group', {name: 'Habibi tools'}).getByRole('button', {name:label, exact:true}).click();
    await page.locator(`.assistant-daily-card [data-daily-workspace="${workspace}"]`).waitFor();
    assert.equal(await page.locator('[data-workspace-link=ask]').getAttribute('aria-current'), 'page');
  }
  assert.equal(await page.evaluate(() => nativeCalls.some(call => call.action === 'reminders.create' || (call.action === 'focus' && call.value?.action === 'start'))), false);
  await page.locator('[data-workspace-link=home]').click();
  providerConfigured = true;
  const launcherInput = page.locator('#command-input');
  await launcherInput.fill('Hello @Demo');
  await launcherInput.dispatchEvent('input');
  const launcherPicker = page.locator('.launcher-mention-host');
  await launcherPicker.getByRole('listbox', { name: 'File and folder mentions' }).waitFor();
  for (const size of [
    { width: 1100, height: 860 },
    { width: 760, height: 580 },
  ]) {
    await page.setViewportSize(size);
    assert.ok(
      await launcherPicker.locator('.assistant-path-menu').evaluate((menu) => {
        const bounds = menu.getBoundingClientRect();
        return (
          bounds.top >= document.querySelector('.search-row').getBoundingClientRect().bottom &&
          bounds.left >= 0 &&
          bounds.right <= innerWidth + 1 &&
          bounds.bottom <= innerHeight
        );
      }),
      'Launcher picker must stay below search and inside the window',
    );
  }
  await page.setViewportSize({ width: 1100, height: 860 });
  await page.screenshot({ path: path.join(screenshots, 'ai-launcher-mentions.png') });
  await launcherInput.press('Escape');
  assert.equal(await launcherPicker.getByRole('listbox').count(), 0);
  assert.equal(await page.locator('#results-view:not(.hidden) #habibi-draft').count(), 0, 'Escape closes only the picker');
  await launcherInput.fill('Rename the receipts in @Demo');
  await launcherInput.dispatchEvent('input');
  await launcherPicker.getByRole('listbox').waitFor();
  await launcherInput.press('ArrowDown');
  await launcherInput.press('Enter');
  const launcherTag = page
    .locator('.launcher-path-tags')
    .getByRole('button', { name: 'Remove path Demo Inbox' });
  await launcherTag.waitFor();
  assert.equal(await launcherInput.inputValue(), 'Rename the receipts in ');
  assert.match(await launcherTag.textContent(), /@Demo Inbox/);
  assert.ok(
    !(await launcherInput.inputValue()).includes('/Users/'),
    'The full path must not appear in the input',
  );
  await launcherTag.hover();
  await page.getByRole('tooltip', { name: demoPath, exact: true }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'ai-path-tags.png') });
  await launcherInput.focus();
  await launcherInput.fill('');
  assert.equal(await launcherTag.count(), 1, 'Editing the text must retain the selected tag');
  await launcherInput.press('Backspace');
  assert.equal(await launcherTag.count(), 0, 'Backspace at the start removes the selected tag');
  await launcherInput.fill('Rename the receipts in @Demo');
  await launcherInput.dispatchEvent('input');
  await launcherPicker.getByRole('listbox').waitFor();
  await launcherInput.press('Enter');
  await launcherTag.waitFor();
  assert.equal(
    await page.locator('#habibi-draft').count(),
    0,
    'First Enter chooses the path instead of activating a search result',
  );
  await launcherInput.press('Enter');
  await page.getByRole('button', { name: 'Prepare with AI' }).waitFor();
  await page
    .locator('.chat-composer')
    .getByRole('button', { name: 'Remove path Demo Inbox' })
    .waitFor();
  assert.ok(
    await fs.stat(path.join(documents, 'scan-01.txt')),
    'Submitting a selected path must not modify files',
  );
  assert.equal(await launcherInput.inputValue(), '', 'Launcher clears after submission');
  await page.locator('[data-workspace-link=home]').click();
  assert.equal(
    await page.locator('.launcher-path-tags button').count(),
    0,
    'Home clears selected launcher scope',
  );
  await page.locator('[data-workspace-link=ask]').click();
  const draft = page.locator('#habibi-draft');
  await draft.waitFor();
  await page.waitForFunction(() => document.querySelector('.assistant-mention-host'));
  await draft.fill('Rename the receipts in @Demo');
  await draft.dispatchEvent('input');
  await page.getByRole('listbox', { name: 'File and folder mentions' }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'ai-path-mentions.png') });
  await page.getByRole('option', { name: /Demo Inbox/ }).click();
  await page.locator('#send-habibi').click();
  await page.getByRole('button', { name: 'Prepare with AI' }).waitFor();
  await page.getByRole('checkbox', { name: 'Include readable file contents' }).click();
  await page.getByRole('button', { name: 'Prepare with AI' }).click();
  await page.getByRole('button', { name: 'Review 2 changes' }).waitFor();
  assert.ok(await fs.stat(path.join(documents, 'scan-01.txt')), 'Planning must not rename files');
  for (const size of [
    { width: 1100, height: 860 },
    { width: 760, height: 580 },
  ]) {
    await page.setViewportSize(size);
    const bounds = await page
      .locator('.assistant-file-card')
      .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(bounds.scroll <= bounds.width + 1);
  }
  await page.setViewportSize({ width: 1100, height: 860 });
  await page.screenshot({ path: path.join(screenshots, 'ai-file-preview.png') });
  await page.getByRole('button', { name: 'Review 2 changes' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.ok(await fs.stat(path.join(documents, 'scan-01.txt')));
  await page.getByRole('button', { name: 'Review 2 changes' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Apply selected changes' }).click();
  await page.getByRole('button', { name: 'Undo these changes' }).waitFor();
  assert.ok(await fs.stat(path.join(documents, '2026-11-06-demo-cafe.txt')));
  await page.getByRole('button', { name: 'Undo these changes' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Undo changes', exact: true }).click();
  await page.getByText('Changes undone. Generated copies were retained privately.').waitFor();
  assert.ok(await fs.stat(path.join(documents, 'scan-01.txt')));
  // Compression must not run while AI plans, or when either dialog is cancelled.
  await fs.writeFile(
    path.join(documents, 'picture.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1cAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  await page.locator('#habibi-draft').fill('Compress the image into a smaller JPEG');
  await page.locator('#send-habibi').click();
  await page.getByRole('button', { name: 'Prepare with AI' }).click();
  const conversion = page.locator('.assistant-file-card').last();
  await conversion.getByRole('button', { name: 'Review output preview' }).waitFor();
  assert.equal(nativeConversions, 0);
  await conversion.getByRole('button', { name: 'Review output preview' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(nativeConversions, 0);
  await conversion.getByRole('button', { name: 'Review output preview' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Generate previews', exact: true })
    .click();
  await conversion.getByRole('link', { name: 'Preview output' }).waitFor();
  assert.equal(nativeConversions, 1);
  await assert.rejects(fs.stat(path.join(documents, 'smaller.jpg')));
  await conversion.getByRole('button', { name: 'Review 1 change' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await assert.rejects(fs.stat(path.join(documents, 'smaller.jpg')));
  await conversion.getByRole('button', { name: 'Review 1 change' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Apply selected changes' }).click();
  await conversion.getByRole('button', { name: 'Undo these changes' }).waitFor();
  assert.ok(await fs.stat(path.join(documents, 'smaller.jpg')));
  assert.equal(nativeConversions, 1);

  // New conversation clears file scope, so daily requests stay independent.
  await page.locator('[data-workspace-link=home]').click();
  await page.locator('[data-workspace-link=ask]').click();
  await page.waitForFunction(() => document.querySelector('.assistant-mention-host'));
  await page.locator('#habibi-draft').fill('Open example.test');
  await page.locator('#send-habibi').click();
  await page.getByRole('button', { name: 'Confirm action', exact: true }).waitFor();
  assert.equal(browserOpens, 0);
  await page
    .getByRole('region', { name: 'Action confirmation' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  assert.equal(browserOpens, 0);
  await page.locator('#habibi-draft').fill('Open example.test');
  await page.locator('#send-habibi').click();
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click();
  await page.getByText('Confirmed action completed.').waitFor();
  assert.equal(browserOpens, 1);
  await page.locator('#habibi-draft').fill('Prepare a 17 minute focus timer called Write proposal');
  await page.locator('#send-habibi').click();
  await page.getByRole('button', { name: 'Start session' }).waitFor();
  assert.equal(
    await page.evaluate(() =>
      nativeCalls.some((call) => call.action === 'focus' && call.value?.action === 'start'),
    ),
    false,
  );
  await page.getByRole('button', { name: 'Start session' }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  assert.ok(
    await page.evaluate(() =>
      nativeCalls.some((call) => call.action === 'focus' && call.value?.seconds === 1020),
    ),
  );
  await page.screenshot({ path: path.join(screenshots, 'ai-timer-chat.png') });
  await page.locator('#habibi-draft').fill('Remind me tomorrow at noon to pack lunch');
  await page.locator('#send-habibi').click();
  await page.getByRole('textbox', { name: 'Reminder title' }).waitFor();
  assert.equal(
    await page.evaluate(() => nativeCalls.some((call) => call.action === 'reminders.create')),
    false,
  );
  await page.getByRole('button', { name: 'Create reminder', exact: true }).click();
  await page.getByRole('button', { name: 'Complete Pack lunch' }).waitFor();
  await page.locator('#habibi-draft').fill('Show my clipboard');
  await page.locator('#send-habibi').click();
  await page.getByRole('switch', { name: 'Enable clipboard history' }).waitFor();
  await page.locator('#habibi-draft').fill('Show my recent files');
  await page.locator('#send-habibi').click();
  await page.getByText('Keep your next attachment close.').waitFor();
  assert.deepEqual(errors, []);
  await context.close();
  await video.saveAs(path.join(screenshots, 'ai-file-workflow.webm'));
  console.log(
    'Assistant UI passed: direct utility shortcuts by click/Enter without AI or automatic writes; launcher and chat @ pickers, compact tags and full-path tooltips, keyboard removal and handoff, consent, real fixture rename/undo, confirmation cancellation, gated compression previews and writes, gated browser actions, responsive preview, timer/reminder review, clipboard and recents in chat.',
  );
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage) {
    console.error(
      'UI failure state:',
      JSON.stringify(
        await failedPage.evaluate(() => ({
          workspace: document.body.dataset.workspace,
          input: document.querySelector('#command-input')?.value,
          draft: document.querySelector('#habibi-draft')?.value,
          messages: document.querySelector('#habibi-messages')?.textContent,
          toast: document.querySelector('#toast')?.textContent,
        })),
      ),
    );
    await failedPage.screenshot({
      path: path.join(os.tmpdir(), 'habibi-assistant-ui-failure.png'),
    });
  }
  throw error;
} finally {
  await browser?.close();
  server.kill();
  await fs.rm(temporary, { recursive: true, force: true });
}
