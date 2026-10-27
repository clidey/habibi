const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssistantRouter, normalizeAssistantPlan, assistantRoutingPrompt } = require('../src/server/services/assistant-router');
const { createLlmService } = require('../src/server/services/llm-service');
const { providerKeychain } = require('./helpers/provider-keychain');

const cases = [
  ['open clidey website', { action: 'open_url', url: 'https://clidey.com/' }],
  ['open downloads', { action: 'open_folder', folder: 'Downloads' }],
  ['launch Safari', { action: 'open_app', app: 'Safari' }],
  ['Find the local project brief PDF', { action: 'local_files' }],
  ['search Airbnb in Paris for two adults', { action: 'browser_search', provider: 'airbnb', query: 'Paris', adults: 2 }],
  ['search my mail for invoices', { action: 'mail', mode: 'search', query: 'invoices' }],
  ['prepare an email to maya@example.test', { action: 'mail', mode: 'compose', to: 'maya@example.test', subject: 'Demo', body: 'See you Monday.' }],
  ['open WhatsApp', { action: 'whatsapp', mode: 'chats' }],
  ['message Maya on WhatsApp saying hello', { action: 'whatsapp', mode: 'message', target: 'Maya', instruction: 'Say hello' }],
  ['show my upcoming meetings', { action: 'calendar', mode: 'upcoming' }],
  ['schedule lunch tomorrow at 1pm', { action: 'calendar', mode: 'draft' }],
  ['ask WhoDB about late orders', { action: 'whodb', question: 'Which orders shipped late?' }],
  ['show production pods', { action: 'kubernetes', query: 'show production pods' }],
  ['open system settings', { action: 'system', name: 'settings' }],
  ['what is WhoDB?', { action: 'chat' }],
];

for (const [request, plan] of cases) test(`the capability router supports: ${request}`, async () => {
  const calls = [];
  const router = createAssistantRouter({ complete: async input => { calls.push(input); return { ok: true, text: JSON.stringify(plan) }; } });
  const result = await router.route({ text: request, context: 'Previously I was finding local files.' });
  assert.equal(result.ok, true);
  assert.equal(result.action, plan.action);
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[0].text, new RegExp(request.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(calls[0].systemPrompt, /never carry an old task/i);
});

test('router failures remain errors rather than pretending to find local files', async () => {
  const router = createAssistantRouter({ complete: async () => ({ ok: false, error: 'OpenAI rejected the saved API key. Paste the complete key again in Model settings.' }) });
  const result = await router.route({ text: 'open clidey website' });
  assert.equal(result.ok, false);
  assert.match(result.error, /OpenAI rejected/);
  assert.notEqual(result.action, 'local_files');
  const malformed = createAssistantRouter({ complete: async () => ({ ok: true, text: 'not json' }) });
  assert.equal((await malformed.route({ text: 'open downloads' })).ok, false);
});

test('plans reject invented URL replacements, paths, unknown tools and destructive code', () => {
  for (const value of [
    { action: 'open_url', url: 'javascript:alert(1)' },
    { action: 'open_url', url: 'file:///etc/passwd' },
    { action: 'open_url', url: 'https://other.example/' },
    { action: 'open_folder', folder: '../../etc' },
    { action: 'system', name: 'run shell' },
    { action: 'exec', command: 'rm -rf' },
  ]) assert.equal(normalizeAssistantPlan(value, 'open https://clidey.com/').action, 'clarify');
  assert.equal(normalizeAssistantPlan({ action: 'open_url', url: 'https://clidey.com/delete?confirm=1' }, 'open clidey website').action, 'clarify');
  assert.equal(normalizeAssistantPlan({ action: 'open_url', url: 'https://127.0.0.1/' }, 'open clidey website').action, 'clarify');
  assert.equal(normalizeAssistantPlan({ action: 'open_url', url: 'https://admin.localhost/' }, 'open clidey website').action, 'clarify');
  const draft = normalizeAssistantPlan({ action: 'mail', mode: 'compose', to: 'invented@example.test', body: 'Hello' }, 'draft a message to Maya');
  assert.equal(draft.to, '');
  assert.equal(draft.mode, 'compose');
});

test('Airbnb preserves valid dates and guests and clarifies invalid date order', () => {
  const valid = { action: 'browser_search', provider: 'airbnb', query: 'Lisbon', checkin: '2026-11-06', checkout: '2026-11-09', adults: 2 };
  assert.deepEqual(normalizeAssistantPlan(valid, 'Airbnb Lisbon'), valid);
  assert.equal(normalizeAssistantPlan({ ...valid, checkout: '2026-11-05' }, 'Airbnb Lisbon').action, 'clarify');
  assert.match(assistantRoutingPrompt(new Date(2026, 9, 29)), /Today is 2026-10-29/);
});

test('the local file planner refuses websites even without a usable model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-file-boundary-'));
  try {
    const service = createLlmService({ root, fs, spawn: providerKeychain() });
    for (const request of ['open clidey website', 'search Airbnb in Paris', 'open my inbox', 'open WhatsApp']) {
      assert.deepEqual(await service.planFileInvestigation({ history: [{ role: 'user', text: 'Find my invoices' }, { role: 'user', text: request }] }), { phase: 'not_applicable' });
    }
    const actualFiles = await service.planFileInvestigation({ history: [{ role: 'user', text: 'Find my saved invoice PDF' }] });
    assert.equal(actualFiles.phase, 'search');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
