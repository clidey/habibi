const test = require('node:test');
const assert = require('node:assert/strict');
const {
  safeEmailHtml,
  splitMailThread,
  dedupeMessages,
} = require('../src/server/services/mail-message-parser');

test('mail HTML keeps current prose while removing active and quoted content', () => {
  const html = safeEmailHtml(
    '<p>Hello <a href="javascript:alert(1)">link</a></p><script>alert(1)</script><hr><p>Quoted</p>',
  );
  assert.match(html, /Hello/);
  assert.doesNotMatch(html, /javascript:|<script|Quoted|alert\(1\)/);
});

test('quoted mail becomes separate directional messages and duplicates collapse', () => {
  const messages = splitMailThread(
    'Current reply\nFrom: Alice <alice@example.com>\nTo: Me <me@example.com>\nSent: 1 Jan 2025\n\nEarlier note',
    'Me <me@example.com>',
    'me@example.com',
    2,
  );
  assert.deepEqual(
    messages.map(({ from, body, direction }) => ({ from, body, direction })),
    [
      { from: 'Me <me@example.com>', body: 'Current reply', direction: 'outgoing' },
      { from: 'Alice <alice@example.com>', body: 'Earlier note', direction: 'incoming' },
    ],
  );
  assert.equal(dedupeMessages([...messages, messages[1]]).length, 2);
});
