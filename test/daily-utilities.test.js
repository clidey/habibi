const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { dailyIntent } = require('../src/client/shared/daily-intent');

test('daily commands route locally without confusing ordinary prose with actions', () => {
  assert.equal(dailyIntent('Tomorrow remind me at 12pm to pack lunch').name, 'reminders');
  assert.deepEqual(dailyIntent('start a 25 minute focus timer'), { name: 'focus', minutes: 25 });
  assert.equal(dailyIntent('show my recent files').name, 'recents');
  assert.equal(dailyIntent('What is a focus timer?'), null);
});

test('reminder drafts separate task text from relative dates, noon, and times', async () => {
  const { reminderDraft } = await import('../src/client/features/daily/reminder-draft.js');
  const now = new Date(2026, 10, 3, 10, 0);
  const draft = reminderDraft('Tomorrow remind me at 12pm to pack lunch', now);
  assert.equal(draft.title, 'pack lunch');
  assert.equal(draft.due, '2026-11-04T12:00');
  assert.equal(reminderDraft('remind me to call Sam in 30 minutes', now).due, '2026-11-03T10:30');
  assert.equal(reminderDraft('remind me to buy milk', now).due, '');
  assert.equal(reminderDraft('remind me tomorrow at 99pm to call', now).due, '');
});
