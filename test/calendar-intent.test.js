const test = require('node:test');
const assert = require('node:assert/strict');

test('calendar drafts recognize the single-time lunch request shown in the launcher', async () => {
  const { calendarDraftFromText } = await import('../src/client/features/calendar/event-intent.js');
  const result = calendarDraftFromText('Lunch with Sana Friday 1pm', new Date(2026, 9, 24, 16, 12));
  assert.equal(result.title, 'Lunch with Sana');
  assert.equal(new Date(result.start).getDay(), 5);
  assert.equal(new Date(result.start).getHours(), 13);
  assert.equal(new Date(result.end) - new Date(result.start), 3600000);
  assert.equal(result.id, undefined, 'a prepared draft must not be treated as an existing event');
});

test('calendar drafts preserve time ranges and today stays on the current day', async () => {
  const { calendarDraftFromText } = await import('../src/client/features/calendar/event-intent.js');
  const now = new Date(2026, 9, 24, 9);
  const result = calendarDraftFromText('Schedule design review today 2pm to 3:30pm', now);
  assert.equal(result.title, 'Design review');
  assert.equal(new Date(result.start).getDate(), now.getDate());
  assert.equal(new Date(result.start).getHours(), 14);
  assert.equal(new Date(result.end) - new Date(result.start), 5400000);
});
