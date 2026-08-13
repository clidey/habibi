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

test('a real, previously-linked disconnected session gets its engine restarted, never destroyed', async () => {
  // The exact case reported live: a session with a real phone/pushName,
  // status disconnected, engineLoaded:false. The automatic UI flow only calls
  // ensureSession() (which restarts the engine) when NO session exists yet —
  // once one exists it polls status-only, so this sat with its engine never
  // reloaded until sessionState() itself learned to retry it too.
  const linked = { id:'1', name:'habibi', status:'disconnected', phone:'447426315115', pushName:'Anguel H', engineLoaded:false };
  await withFakeOpenwa([linked], async ({ baseUrl, workspace, calls, getSessions }) => {
    const client = createOpenwaClient({ workspace, baseUrl, staleAfterMs:10 });
    const state = await client.sessionState();
    assert.equal(state.session.id, '1', 'the linked session must never be replaced');
    assert.equal(state.session.phone, '447426315115', 'the real linked device info must be preserved');
    assert.equal(calls.some(call => call.includes('force-kill')), false, 'a disconnected session must never be force-killed');
    assert.ok(calls.some(call => call === 'POST /api/sessions/1/start'), 'the engine must be restarted for a disconnected, not-yet-loaded session');
    assert.equal(getSessions()[0].engineLoaded, true, 'the same session row must now show its engine loaded');
  });
});

test('restarting a disconnected session\'s engine is throttled, not retried on every poll', async () => {
  const linked = { id:'1', name:'habibi', status:'disconnected', engineLoaded:false };
  await withFakeOpenwa([linked], async ({ baseUrl, workspace, calls, getSessions }) => {
    const client = createOpenwaClient({ workspace, baseUrl, staleAfterMs:10 });
    await client.sessionState();
    // The fake server always sets engineLoaded:true on /start, so force it back
    // to false to prove a second immediate poll does NOT retry within the
    // throttle window even though the session still looks unloaded.
    getSessions()[0].engineLoaded = false;
    await client.sessionState();
    const startCalls = calls.filter(call => call === 'POST /api/sessions/1/start');
    assert.equal(startCalls.length, 1, 'a second poll inside the throttle window must not restart the engine again');
  });
});

// forceReset is the "Refresh pairing" button's real last-resort action (F4):
// unlike the automatic paths, it force-kills a session even if it is merely
// disconnected (not just the pre-link healable statuses), because it is only
// reachable from a screen the user already sees because something looks stuck.
test('forceReset force-kills and replaces a session immediately, bypassing the staleness timer', async () => {
  const linked = { id:'1', name:'habibi', status:'disconnected', engineLoaded:false };
  await withFakeOpenwa([linked], async ({ baseUrl, workspace, calls, getSessions }) => {
    const client = createOpenwaClient({ workspace, baseUrl, staleAfterMs:60_000 });
    await client.forceReset();
    assert.ok(calls.some(call => call === 'POST /api/sessions/1/force-kill'), 'must force-kill the existing session immediately');
    assert.ok(calls.some(call => call === 'DELETE /api/sessions/1'), 'must delete the existing session');
    assert.equal(getSessions().some(session => session.id === '1'), false, 'the old session row must be gone');
    assert.equal(getSessions().some(session => session.name === 'habibi'), true, 'a fresh session must exist after resetting');
  });
});

test('forceReset resets the staleness and restart-throttle state so the fresh session is not immediately re-healed', async () => {
  await withFakeOpenwa([{ id:'1', name:'habibi', status:'created', engineLoaded:false }], async ({ baseUrl, workspace, calls }) => {
    const client = createOpenwaClient({ workspace, baseUrl, staleAfterMs:10 });
    // Let the original session become "stuck" from this client's point of view.
    await client.sessionState();
    await new Promise(resolve => setTimeout(resolve, 20));
    await client.forceReset();
    const killCalls = calls.filter(call => call === 'POST /api/sessions/1/force-kill');
    assert.equal(killCalls.length, 1, 'forceReset itself must be the only thing that force-kills session 1');
    // A poll right after forceReset must not immediately heal the brand-new
    // replacement session again.
    const state = await client.sessionState();
    assert.notEqual(state.session.id, '1', 'the new session must not be the original id');
    assert.equal(calls.filter(call => call.includes('force-kill')).length, 1, 'the freshly created session must not be force-killed again right away');
  });
});
