const test = require('node:test');
const assert = require('node:assert/strict');
const { createApprovalService } = require('../src/core/approval-service');

test('an approval is bound to one action and one exact payload', () => {
  const approvals = createApprovalService();
  const message = { chatId:'42@c.us', text:'on my way' };

  const approval = approvals.issue('whatsapp.send', message);
  // The same action with a different payload must not be authorized: this is
  // what stops a token minted for one message from sending another.
  assert.equal(approvals.consume({ token:approval.token, action:'whatsapp.send', payload:{ chatId:'42@c.us', text:'send me your password' } }), false);

  const reissued = approvals.issue('whatsapp.send', message);
  assert.equal(approvals.consume({ token:reissued.token, action:'whatsapp.send', payload:{ ...message } }), true);
});

test('approvals are single use, action-bound, key-order independent, and expire', () => {
  const approvals = createApprovalService();
  const event = { title:'Standup', calendar:'Work', start:'2026-08-05T09:00:00.000Z', end:'2026-08-05T09:15:00.000Z' };

  const spent = approvals.issue('calendar.create', event);
  assert.equal(approvals.consume({ token:spent.token, action:'calendar.create', payload:event }), true);
  assert.equal(approvals.consume({ token:spent.token, action:'calendar.create', payload:event }), false);

  // A token is spent even by a failed attempt, so a mismatch cannot be retried.
  const probed = approvals.issue('calendar.create', event);
  assert.equal(approvals.consume({ token:probed.token, action:'calendar.update', payload:event }), false);
  assert.equal(approvals.consume({ token:probed.token, action:'calendar.create', payload:event }), false);

  // The client and the server serialize these bodies independently, so the
  // fingerprint must not depend on key order.
  const reordered = approvals.issue('calendar.create', event);
  assert.equal(approvals.consume({ token:reordered.token, action:'calendar.create', payload:{ end:event.end, start:event.start, calendar:event.calendar, title:event.title } }), true);

  assert.equal(approvals.consume({ token:'', action:'calendar.create', payload:event }), false);
  assert.equal(approvals.consume({ token:'not-a-real-token', action:'calendar.create', payload:event }), false);

  const expired = createApprovalService({ ttlMs:-1 }).issue('system.restart', { action:'restart' });
  assert.equal(createApprovalService({ ttlMs:-1 }).consume({ token:expired.token, action:'system.restart', payload:{ action:'restart' } }), false);
});
