const test = require('node:test');
const assert = require('node:assert/strict');
const { asHabibiToolName, evaluateToolCall } = require('../src/agent/harness-policy');

test('harness requires real user approval for every tool, including reads and compression', () => {
  for (const name of ['whatsapp_search_chats', 'compress', 'pdf_merge', 'open_folder', 'unknown_tool']) {
    assert.equal(evaluateToolCall({ name, annotations: { readOnlyHint: true } }).decision, 'require_confirmation');
    assert.equal(evaluateToolCall({ name, redeemApproval: () => false }).decision, 'require_confirmation');
    assert.equal(evaluateToolCall({ name, redeemApproval: () => true }).decision, 'allow');
  }
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
