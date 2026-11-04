import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

export async function checkNotesUi(page) {
  const content = page.locator('.tiptap');
  await content.waitFor();
  assert.equal(await page.locator('#note-format-bar').count(), 0);
  assert.equal(await page.locator('.notes-collection-picker').getAttribute('open'), null);
  const sidebar = await page.locator('.notes-sidebar').boundingBox();
  assert.ok(sidebar.width <= 210, 'Notes navigation should leave room for the document');
  await page.locator('#note-title').fill('A quieter workspace');
  await content.fill('/todo');
  await page.getByRole('option', { name: 'To-do list' }).click();
  await page.keyboard.type('Write with fewer distractions');
  assert.equal(await content.locator('input[type="checkbox"]').count(), 1);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Keep every editing feature');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Select text to format it.');
  await page.keyboard.press('Shift+Meta+ArrowLeft');
  await page.getByRole('toolbar', { name: 'Format selection' }).waitFor();
  await page.getByRole('button', { name: 'Bold · ⌘B', exact: true }).click();
  assert.ok(await content.locator('strong').count());
  await page.keyboard.press('ArrowRight');
  await checkFloatingTools(page, content);
  await checkTableTools(page, content);
  await page.locator('#notes-toggle-list').click();
  assert.equal(await page.locator('.notes-sidebar').isVisible(), false);
  assert.equal(await page.locator('#notes-toggle-list').getAttribute('aria-expanded'), 'false');
  await page.locator('#notes-toggle-list').click();
  assert.equal(await page.locator('.notes-sidebar').isVisible(), true);
  await page.getByRole('button', { name: 'Note actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export Markdown…' }).waitFor();
  await page.getByRole('menuitem', { name: 'Move to folder…' }).click();
  await page.getByRole('dialog').waitFor();
  await page.locator('#notes-dialog-close').click();
  await page.locator('.notes-collection-picker > summary').click();
  await page.locator('[data-folder="trash"]').click();
  await page.locator('#notes-toggle-list').click();
  assert.equal(await page.locator('.notes-sidebar').isVisible(), false);
  await page.locator('#notes-toggle-list').click();
  await page.locator('.notes-collection-picker > summary').click();
  await page.locator('[data-folder="all"]').click();
  await content.waitFor();
  await page.screenshot({ path: path.join(os.tmpdir(), 'habibi-notes-minimal.png') });
}

async function checkFloatingTools(page, content) {
  await content.fill('Floating menus stay visible.');
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Enter');
    await page.keyboard.type('Another paragraph in a long note.');
  }
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await page.locator('.notes-command-menu').waitFor();
  await page.evaluate(() => {
    const area = document.querySelector('.notes-editor-scroll');
    const caret = [...document.querySelectorAll('.tiptap p')].at(-1).getBoundingClientRect();
    area.scrollTop += caret.bottom - (area.getBoundingClientRect().bottom - 25);
  });
  await page.waitForFunction(
    () => document.querySelector('.notes-command-menu')?.dataset.side === 'top' && !document.querySelector('.notes-command-menu').hidden,
  );
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  const bounds = await page.locator('.notes-command-menu').evaluate((menu) => {
    const frame = document.querySelector('.notes-workspace').getBoundingClientRect();
    const rect = menu.getBoundingClientRect();
    return {
      outside: menu.parentElement === document.body,
      fits: rect.top >= frame.top && rect.bottom <= frame.bottom,
      horizontal: rect.left >= 0 && rect.right <= window.innerWidth,
    };
  });
  assert.deepEqual(bounds, { outside: true, fits: true, horizontal: true });
  await page.keyboard.press('ArrowUp');
  assert.equal(
    await page.getByRole('option', { selected: true }).locator('b').textContent(),
    'Table',
  );
  await page.screenshot({ path: path.join(os.tmpdir(), 'habibi-notes-floating-menu.png') });
  await page.keyboard.press('Enter');
  assert.equal(await content.locator('table').count(), 1);
  assert.equal(await page.locator('.notes-command-menu').isVisible(), false);
  await content.fill('/');
  await page.locator('.notes-command-menu').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.notes-workspace').isVisible(), true);
  assert.equal(await page.locator('.notes-command-menu').isVisible(), false);
  await content.fill('Select text to format it.');
}

async function checkTableTools(page, content) {
  await content.fill('/table');
  await page.getByRole('option', { name: /Table/ }).click();
  const table = content.locator('table');
  await table.locator('th').first().click();
  await page.keyboard.type('Internal cell');
  const toolbar = page.getByRole('toolbar', { name: 'Table actions' });
  await toolbar.getByRole('button', { name: '+ Row', exact: true }).click();
  assert.equal(await table.locator('tr').count(), 4);
  await toolbar.getByRole('button', { name: '+ Column', exact: true }).click();
  assert.equal(await table.locator('tr').first().locator('th,td').count(), 4);
  await table.locator('td').last().click();
  await page.keyboard.press('Tab');
  assert.equal(await table.locator('tr').count(), 5);
  await page.waitForFunction(() => document.querySelector('.notes-list-item.selected small')?.textContent === 'Table');
  assert.equal(await page.locator('.notes-list-item.selected .notes-list-icon [data-icon-source="ux-catalog"]').count(), 1);
  await toolbar.getByRole('button', { name: 'More table actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete table', exact: true }).click();
  assert.equal(await content.locator('table').count(), 0);
  assert.equal(await page.locator('.notes-table-tools').isVisible(), false);
  await content.fill('Select text to format it.');
}
