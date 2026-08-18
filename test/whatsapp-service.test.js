const test = require('node:test');
const assert = require('node:assert/strict');
const { createWhatsAppService } = require('../src/server/services/whatsapp-service');

const service = createWhatsAppService({
  root: process.cwd(),
  fs: require('fs'),
  spawn: require('child_process').spawn,
  openwaClient: {
    request: async () => ({}),
    sessionState: async () => ({ session: null }),
    ensureSession: async () => {},
  },
});

test('collapses duplicate connector rows by chat id and keeps the newest preview', () => {
  const [chat] = service.dedupeChats([
    { id: '447700@c.us', name: 'Alex', timestamp: 10, lastMessage: 'older', unreadCount: 1 },
    {
      id: '447700@c.us',
      name: 'Alex',
      timestamp: 20,
      lastMessage: 'newer',
      unreadCount: 0,
      avatar: 'https://example.test/avatar.jpg',
    },
  ]);
  assert.equal(chat.lastMessage, 'newer');
  assert.equal(chat.unreadCount, 1);
  assert.equal(chat.avatar, 'https://example.test/avatar.jpg');
});

test('accepts only a timestamped visible recents snapshot', () => {
  const valid = Array.from({ length: 5 }, (_, index) => ({
    id: `${index}@c.us`,
    timestamp: index + 1,
    kind: 'individual',
  }));
  const invalid = valid.map((chat) => ({ ...chat, timestamp: 0 }));
  assert.equal(service.hasUsableRecents(valid), true);
  assert.equal(service.hasUsableRecents(invalid), false);
});
