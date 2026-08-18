const test = require('node:test');
const assert = require('node:assert/strict');
const { asHabibiToolName, evaluateToolCall } = require('../src/agent/harness-policy');

test('harness allows reads but stops all unapproved writes', () => {
  assert.deepEqual(evaluateToolCall({ name: 'whatsapp_search_chats' }), { decision: 'allow' });
  assert.equal(
    evaluateToolCall({ name: 'whatsapp_send_message' }).decision,
    'require_confirmation',
  );
  assert.equal(
    evaluateToolCall({ name: 'calendar_create_event', redeemApproval: () => true }).decision,
    'allow',
  );
  // A write is only allowed when the approval was actually redeemed. The gate
  // takes a verifier, not a token string, so a stray truthy value cannot pass.
  assert.equal(
    evaluateToolCall({ name: 'calendar_create_event', redeemApproval: () => false }).decision,
    'require_confirmation',
  );
});

test('MCP tools receive a stable namespaced Habibi name', () => {
  assert.equal(
    asHabibiToolName('Google Calendar', 'create-event'),
    'mcp__Google_Calendar__create_event',
  );
});
