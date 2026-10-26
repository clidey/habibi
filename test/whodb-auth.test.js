const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createWhoDbAuth, whoDbUrl, whoDbConnectedUrl } = require('../src/connectors/whodb-auth');
const { createWhoDbPlatform } = require('../src/connectors/whodb-platform');
const { createWhoDbKeychain } = require('../src/connectors/whodb-keychain');
const { EventEmitter } = require('node:events');

function fixture(overrides = {}) {
  const calls = [];
  const saved = new Map();
  let clock = Date.now();
  const store = { get: async (host) => saved.get(host), set: async (host, value) => saved.set(host, value) };
  const fetcher = async (url, options) => {
    calls.push({ url: String(url), options });
    let data;
    if (String(url).endsWith('/api/auth-config')) data = { version: 2, issuer: 'https://auth.example.test/realm', clientId: 'whodb-cli', flows: { authorizationCodePkce: true } };
    else if (String(url).endsWith('/.well-known/openid-configuration')) data = { issuer: 'https://auth.example.test/realm', authorization_endpoint: 'https://auth.example.test/authorize', token_endpoint: 'https://auth.example.test/token', ...overrides.discovery };
    else if (String(url).endsWith('/token')) data = { access_token: `access-${clock++}`, refresh_token: 'rotated-refresh-secret', token_type: 'Bearer', expires_in: overrides.expiresIn || 3600 };
    else throw new Error('Unexpected request');
    return new Response(JSON.stringify(data), { status: 200 });
  };
  const connected = [];
  const opened = [];
  const auth = createWhoDbAuth({ store, fetcher, onConnected: (host) => connected.push(host), openBrowser: async (url) => opened.push(url), loginTimeout: overrides.timeout || 1000 });
  return { auth, calls, store, saved, connected, opened };
}

test('WhoDB SSO uses CLI discovery, random loopback callback, state and S256 PKCE; secrets stay out of envelopes', async () => {
  const { auth, calls, saved, connected, opened } = fixture();
  const login = await auth.begin();
  assert.equal(login.ok, true);
  try {
    const url = new URL(login.url);
    const redirect = url.searchParams.get('redirect_uri');
    assert.equal(new URL(redirect).hostname, '127.0.0.1');
    assert.notEqual(new URL(redirect).port, '4173');
    assert.equal(url.searchParams.get('client_id'), 'whodb-cli');
    assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal((await auth.open('untrusted-id')).ok, false);
    assert.equal(opened.length, 0);
    assert.equal((await auth.open(login.id)).ok, true);
    assert.deepEqual(opened, [login.url], 'only the server-owned authorization URL can be opened');
    assert.equal(calls[0].url, 'https://app.whodb.com/api/auth-config');
    assert.equal((await fetch(`${redirect}/?state=wrong&code=stolen`)).status, 400);
    assert.equal(saved.size, 0);
    assert.equal((await auth.begin()).ok, false);
    const waiting = auth.wait(login.id);
    const callback = new URL(redirect);
    callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'one-time-code' });
    const completion = await fetch(callback, { redirect: 'manual' });
    assert.equal(completion.status, 302);
    assert.equal(completion.headers.get('location'), 'https://app.whodb.com/mcp-connected');
    assert.equal(completion.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await waiting, { ok: true });
    assert.deepEqual(connected, ['https://app.whodb.com']);
    const exchange = calls.find((call) => call.url.endsWith('/token'));
    const form = new URLSearchParams(exchange.options.body);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('redirect_uri'), redirect);
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
    assert.equal(JSON.stringify(login).includes('refresh-secret'), false);
    const count = calls.length;
    assert.ok((await auth.token(login.host)).startsWith('access-'));
    assert.equal(calls.length, count, 'warm credentials do not trigger network work');
    await assert.rejects(fetch(callback), /fetch failed/);
  } finally { auth.cancel(login.id); }
});

test('WhoDB completion redirect matches the CLI for hosted and local instances', () => {
  for (const [host, destination] of [
    ['https://app.whodb.com', 'https://app.whodb.com/mcp-connected'],
    ['https://whodb.example.test/', 'https://whodb.example.test/mcp-connected'],
    ['http://localhost:8080', 'http://localhost:3000/mcp-connected'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:3000/mcp-connected'],
    ['http://[::1]:8080', 'http://[::1]:3000/mcp-connected'],
    ['http://localhost:4000', 'http://localhost:4000/mcp-connected'],
    ['https://whodb.example.test:8080', 'https://whodb.example.test:8080/mcp-connected'],
  ]) assert.equal(whoDbConnectedUrl(host), destination);
});

test('WhoDB Keychain writes use stdin and never expose tokens through process arguments', async () => {
  const calls = [];
  const writes = [];
  let saved;
  const keychain = createWhoDbKeychain({ spawnProcess(program, args) {
    calls.push([program, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (value) => {
      if (args[0] === 'set') { writes.push(value); saved = value; }
      queueMicrotask(() => { if (args[0] === 'get') child.stdout.emit('data', saved); child.emit('close', 0); });
    };
    return child;
  } });
  await keychain.set('https://app.whodb.com', { accessToken: 'private-access-token', refreshToken: 'private-refresh-token' });
  assert.ok(writes[0].includes('private-access-token'));
  assert.ok(writes[0].includes('private-refresh-token'));
  assert.equal(calls[0][1], 'set');
  assert.equal(calls[1][1], 'get', 'credentials must read back intact before sign-in succeeds');
  assert.ok(calls[0][0].endsWith('HabibiKeychain'));
  assert.equal(JSON.stringify(calls).includes('private-'), false);
});

test('truncated Keychain writes cannot report a successful sign-in', async () => {
  let saved;
  const keychain = createWhoDbKeychain({ spawnProcess(_program, args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (value) => {
      if (args[0] === 'set') saved = value.slice(0, 128);
      queueMicrotask(() => { if (args[0] === 'get') child.stdout.emit('data', saved); child.emit('close', 0); });
    };
    return child;
  } });
  await assert.rejects(keychain.set('https://app.whodb.com', { accessToken: 'a'.repeat(8000), refreshToken: 'r'.repeat(8000), expiresAt: Date.now() + 3600000 }), /could not be verified/);
  assert.equal(await keychain.get('https://app.whodb.com'), null);
});

test('WhoDB SSO rejects foreign issuer endpoints and insecure hosts; cancellation/expiry closes callback listener', async () => {
  for (const value of ['http://example.test', 'https://user:password@example.test', 'javascript:alert(1)', 'https://example.test/?token=secret']) assert.throws(() => whoDbUrl(value));
  const bad = fixture({ discovery: { token_endpoint: 'https://attacker.example/token' } });
  assert.equal((await bad.auth.begin()).ok, false);
  assert.equal(bad.calls.some((call) => call.url.includes('attacker')), false);
  for (const expire of [false, true]) {
    const { auth, saved } = fixture({ timeout: expire ? 25 : 1000 });
    const login = await auth.begin();
    const redirect = new URL(login.url).searchParams.get('redirect_uri');
    const waiting = auth.wait(login.id);
    if (!expire) auth.cancel(login.id);
    assert.equal((await waiting).ok, false);
    assert.equal(saved.size, 0);
    await assert.rejects(fetch(redirect), /fetch failed/);
  }
});

test('WhoDB refresh is lazy and rotated refresh tokens remain in credential storage', async () => {
  const { auth, store, saved, calls } = fixture();
  const host = 'https://app.whodb.com';
  await store.set(host, { accessToken: 'expired', refreshToken: 'old-refresh-secret', expiresAt: 0 });
  const token = await auth.token(host);
  assert.ok(token.startsWith('access-'));
  assert.equal(saved.get(host).refreshToken, 'rotated-refresh-secret');
  const form = new URLSearchParams(calls.find((call) => call.url.endsWith('/token')).options.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'old-refresh-secret');
  const count = calls.length;
  assert.equal(await auth.token(host), token);
  assert.equal(calls.length, count);
});

test('built-in SSO platform adapter fixes queries, workspace headers and scan/row bounds', async () => {
  const calls = [];
  const host = 'https://app.whodb.com';
  const adapter = createWhoDbPlatform({ auth: { token: async (requested) => { assert.equal(requested, host); return 'private-access'; } }, fetcher: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ data: { OntologyQuery: { columns: ['count'], rows: [[3]] } } }));
  } });
  await adapter.readSession(host, async (session) => {
    assert.ok(session.tools.every((tool) => tool.annotations.readOnlyHint));
    const workspace = { host, org: 'acme', project: 'retail' };
    const result = await session.call('whodb_platform_ontology_query', { workspace, query: 'mutation { DeleteEverything }', input: { entity: 'orders', pageSize: 999999, scanLimit: 999999, workspace: { project: 'other' } } });
    assert.deepEqual(result.structuredContent.data.rows, [[3]]);
    const request = calls[0];
    const body = JSON.parse(request.options.body);
    assert.ok(body.query.startsWith('query HabibiOntologyQuery'));
    assert.equal(body.query.includes('mutation'), false);
    assert.deepEqual(body.variables.input, { entity: 'orders', pageSize: 100, offset: 0, scanLimit: 5000 });
    assert.equal(request.options.headers['X-Whodb-Org-Id'], 'acme');
    assert.equal(request.options.headers['X-Whodb-Project-Id'], 'retail');
    assert.equal(request.options.redirect, 'error');
    await assert.rejects(session.call('whodb_platform_update', { workspace }));
    await assert.rejects(session.call('constructor', { workspace }));
    await assert.rejects(session.call('whodb_platform_orgs', { workspace: { host: 'https://attacker.test' } }));
    await assert.rejects(session.call('whodb_platform_ontology_query', { workspace: { host } }));
    assert.equal(calls.length, 1);
  });
});
