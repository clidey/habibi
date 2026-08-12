const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenwaClient } = require('../src/connectors/openwa-client');

// OpenWA's session row lives in its own SQLite DB, independent of the app or
// WhatsApp-component version — replacing/upgrading the component does nothing
// to unstick a session whose engine crashed or never finished launching.
// Before this fix, recovering required deleting .openwa by hand every time.
// A real HTTP server (not a fetch mock) exercises the actual request/response
// cycle sessionState() and ensureSession() drive, including the force-kill +
// delete + recreate sequence.
const withFakeOpenwa = async (initialSessions, run) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-openwa-heal-'));
  fs.mkdirSync(path.join(workspace, '.openwa', 'data'), { recursive:true });
  fs.writeFileSync(path.join(workspace, '.openwa', 'data', '.api-key'), 'test-key');

  let sessions = initialSessions.map(session => ({ ...session }));
  const calls = [];
  let nextId = 100;

  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const send = (status, payload) => {
        response.writeHead(status, { 'Content-Type':'application/json' });
        response.end(payload === undefined ? '' : JSON.stringify(payload));
      };
      const url = request.url;
      calls.push(`${request.method} ${url}`);
      if (url === '/api/sessions' && request.method === 'GET') return send(200, sessions);
      if (url === '/api/sessions' && request.method === 'POST') {
        const parsed = JSON.parse(body || '{}');
        const created = { id:String(nextId++), name:parsed.name, status:'created', engineLoaded:false };
        sessions.push(created);
        return send(201, created);
      }
      const startMatch = url.match(/^\/api\/sessions\/([^/]+)\/start$/);
      if (startMatch && request.method === 'POST') {
        const session = sessions.find(item => item.id === startMatch[1]);
        if (session) session.engineLoaded = true;
        return send(200, session || {});
      }
      const killMatch = url.match(/^\/api\/sessions\/([^/]+)\/force-kill$/);
      if (killMatch && request.method === 'POST') return send(200, {});
      const deleteMatch = url.match(/^\/api\/sessions\/([^/]+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        sessions = sessions.filter(item => item.id !== deleteMatch[1]);
        return send(204);
      }
      send(404, { error:'not found' });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await run({ baseUrl:`http://127.0.0.1:${port}`, workspace, calls, getSessions:() => sessions });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(workspace, { recursive:true, force:true });
  }
};

test('a session stuck in "created" past the threshold is force-killed, deleted, and replaced', async () => {
  await withFakeOpenwa([{ id:'1', name:'habibi', status:'created', engineLoaded:false }], async ({ baseUrl, workspace, calls, getSessions }) => {
    const client = createOpenwaClient({ workspace, baseUrl, staleAfterMs:10 });

    // First check just starts the staleness timer — must not heal immediately.
    const first = await client.sessionState();
    assert.equal(first.session.id, '1', 'an unstale session must be returned as-is, not healed on first sight');
    assert.equal(calls.some(call => call.includes('force-kill')), false);

    await new Promise(resolve => setTimeout(resolve, 20));

    const second = await client.sessionState();
    assert.notEqual(second.session.id, '1', 'the stuck session must be replaced, not returned again');
    assert.equal(second.session.status, 'created', 'the replacement is a fresh session, not the healed one resurrected');
    assert.ok(calls.some(call => call === 'POST /api/sessions/1/force-kill'), 'must force-kill the stuck session');
    assert.ok(calls.some(call => call === 'DELETE /api/sessions/1'), 'must delete the stuck session');
    assert.equal(getSessions().some(session => session.id === '1'), false, 'the stuck session must actually be gone');
  });
});

test('a disconnected session is never auto-healed, even past the threshold', async () => {
  // Disconnected sessions were created with autoReconnect:true; force-killing
  // one would destroy a real linked WhatsApp device and force an unwanted
  // re-scan. OpenWA's own reconnect logic owns recovering from this state.
  await withFakeOpenwa([{ id:'1', name:'habibi', status:'disconnected', engineLoaded:true, connectedAt:new Date().toISOString() }], async ({ baseUrl, workspace, calls }) => {
    const client = createOpenwaClient({ workspace, baseUrl, staleAfterMs:10 });
    await client.sessionState();
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = await client.sessionState();
    assert.equal(second.session.id, '1', 'a disconnected session must never be replaced');
    assert.equal(calls.some(call => call.includes('force-kill')), false, 'a disconnected session must never be force-killed');
  });
});

test('a session already making progress resets the staleness timer', async () => {
  await withFakeOpenwa([{ id:'1', name:'habibi', status:'created', engineLoaded:false }], async ({ baseUrl, workspace, calls, getSessions }) => {
    const client = createOpenwaClient({ workspace, baseUrl, staleAfterMs:10 });
    await client.sessionState();
    // Progress arrives before the threshold: move the same session to qr_ready.
    getSessions()[0].status = 'qr_ready';
    await new Promise(resolve => setTimeout(resolve, 20));
    const afterProgress = await client.sessionState();
    assert.equal(afterProgress.session.id, '1', 'a session that reached qr_ready must never be healed');
    // Now regress it back to a healable status — the timer must restart, not
    // treat this as still-stuck-since-the-original-observation.
    getSessions()[0].status = 'created';
    const justRegressed = await client.sessionState();
    assert.equal(justRegressed.session.id, '1', 'immediately after regressing, healing must not fire yet');
    assert.equal(calls.some(call => call.includes('force-kill')), false);
  });
});

test('ensureSession heals a stuck session the same way sessionState does', async () => {
  await withFakeOpenwa([{ id:'1', name:'habibi', status:'failed', engineLoaded:true }], async ({ baseUrl, workspace, calls, getSessions }) => {
    const client = createOpenwaClient({ workspace, baseUrl, staleAfterMs:10 });
    await client.ensureSession();
    await new Promise(resolve => setTimeout(resolve, 20));
    await client.ensureSession();
    assert.ok(calls.some(call => call === 'POST /api/sessions/1/force-kill'));
    assert.equal(getSessions().some(session => session.id === '1'), false);
    assert.equal(getSessions().some(session => session.name === 'habibi'), true, 'a fresh session must exist after healing');
  });
});
