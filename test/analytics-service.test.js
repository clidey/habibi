const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnalyticsService } = require('../src/server/services/analytics-service');

test('analytics forwards only allowlisted anonymous product fields', async () => {
  const calls = [];
  const analytics = createAnalyticsService({ apiKey:'test-key', host:'https://analytics.example', send:async (...args) => { calls.push(args); return { ok:true }; } });
  const captured = await analytics.capture({
    event:'habibi.search.submitted',
    distinctId:'5beee387-4b03-49c6-8ca0-96bd64372088',
    properties:{ query_length_bucket:'21-80', query:'passport for Alice', filename:'/Users/alice/visa.pdf', has_attachments:false },
  });
  assert.equal(captured, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://analytics.example/capture/');
  const body = JSON.parse(calls[0][1].body);
  assert.deepEqual(body.properties, { distinct_id:'5beee387-4b03-49c6-8ca0-96bd64372088', product:'habibi', query_length_bucket:'21-80', has_attachments:false });
});

test('analytics rejects unknown events and malformed identities', async () => {
  const analytics = createAnalyticsService({ apiKey:'test-key', send:async () => { throw new Error('must not call'); } });
  assert.equal(await analytics.capture({ event:'habibi.chat.prompt', distinctId:'not-an-id' }), false);
});
