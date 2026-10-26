const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWhoDbService } = require('../src/server/services/whodb-service');
const { normalizeWhoDbResult, unwrapWhoDbResult } = require('../src/server/services/whodb-results');

async function fixture(run, plans = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-whodb-'));
  const calls = [];
  const tools = ['orgs', 'projects', 'apps', 'ontology_describe', 'ontology_query'].map((name) => ({ name: 'whodb_platform_' + name, annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }));
  const outputs = { orgs: { orgs: [{ id: 'acme', name: 'Acme' }] }, projects: { projects: [{ id: 'retail', name: 'Retail' }] }, apps: { data: [{ id: 'desk', name: 'Order Desk' }] }, ontology_describe: { data: { entities: [{ apiName: 'orders' }] } }, ontology_query: { data: { columns: ['region', 'total'], rows: [['North', 42]], partial: true }, warnings: ['Scan limited'] } };
  const bridge = { list: () => [{ id: 'whodb', name: 'WhoDB', transport: 'stdio' }], readSession: async (_id, run) => run({ tools, call: async (name, args) => { calls.push({ name, args }); return { structuredContent: outputs[name.replace('whodb_platform_', '')] }; } }) };
  const llmService = { complete: async () => ({ ok: true, text: JSON.stringify(plans.shift() || { answer: '42 rows were returned.' }) }) };
  const service = createWhoDbService({ root, fs, bridge, llmService });
  try {
    assert.equal((await service.connect({ serverId: 'whodb', host: 'https://example.test' })).ok, true);
    await run(service, calls);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('WhoDB scopes and apps come from read tools and credentials never enter status', async () => {
  await fixture(async (service, calls) => {
    const scope = await service.scope({ org: 'acme' });
    assert.equal(scope.org.id, 'acme');
    assert.equal((await service.apps({ org: 'acme', project: 'retail' })).apps[0].name, 'Order Desk');
    assert.ok(calls.every((call) => /orgs|projects|apps/.test(call.name)));
    assert.equal(service.status().readOnly, true);
    assert.equal(service.status().token, undefined);
    assert.equal((await service.scope({ org: 'other-org' })).org, null);
  });
});

test('model tool calls cannot change workspace, expand limits, or execute writes', async () => {
  await fixture(async (service, calls) => {
    const result = await service.ask({ org: 'acme', project: 'retail', question: 'Revenue by region' });
    assert.equal(result.ok, true);
    const query = calls.find((call) => call.name === 'whodb_platform_ontology_query');
    assert.deepEqual(query.args.workspace, { host: 'https://example.test', org: 'acme', project: 'retail' });
    assert.equal(query.args.host, undefined);
    assert.equal(query.args.limit, 100);
    assert.equal(result.datasets[0].partial, true);
    assert.deepEqual(result.datasets[0].warnings, ['Scan limited']);
  }, [{ tool: 'whodb_platform_ontology_query', arguments: { entity: 'orders', workspace: { org: 'other-org' }, host: 'https://other.test', limit: 100000 } }, { answer: 'WhoDB returned a partial result.' }]);
  await fixture(async (service, calls) => {
    const result = await service.ask({ org: 'acme', project: 'retail', question: 'Please change an order' });
    assert.equal(result.ok, false);
    assert.ok(!calls.some((call) => call.name.includes('update')));
    assert.equal((await service.ask({ question: 'Update order 42' })).ok, false);
  }, [{ tool: 'whodb_platform_update', arguments: { id: '42' } }]);
});

test('ontology mode reads metadata without calling a model; errors and malformed results fail closed', async () => {
  await fixture(async (service, calls) => {
    const result = await service.ask({ org: 'acme', project: 'retail', question: 'Describe ontology', mode: 'ontology' });
    assert.equal(result.ok, true);
    assert.ok(calls.some((call) => call.name === 'whodb_platform_ontology_describe'));
    assert.equal((await service.connect({ serverId: 'missing' })).ok, false);
    assert.equal((await service.connect({ serverId: 'whodb', host: 'javascript:alert(1)' })).ok, false);
  });
  assert.throws(() => unwrapWhoDbResult({ isError: true, content: [] }));
  assert.throws(() => unwrapWhoDbResult({ structuredContent: { error: 'private credential error' } }));
  const result = normalizeWhoDbResult({ data: { columns: ['name'], rows: Array.from({ length: 500 }, () => ['test']) } }, 'Retail');
  assert.equal(result.rows.length, 100);
  assert.equal(result.partial, true);
  assert.equal(result.sql, '');
});
