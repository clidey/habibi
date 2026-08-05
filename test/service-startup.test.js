const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { HOST, PORT } = require('../src/core/http-security');

test('the loopback address and port have one definition', () => {
  assert.equal(HOST, '127.0.0.1');
  assert.equal(PORT, 4173);
});

// A failure to acquire the port used to be swallowed by the uncaughtException
// handler: the process stayed alive serving nothing, so the launcher looked like
// it had started while its window pointed at a different server.
test('the service exits loudly when its port is already taken', async () => {
  // Something already on the port is the very condition under test, so a real
  // Habibi running on this machine satisfies it — just skip our own blocker.
  const blocker = net.createServer();
  const ownsPort = await new Promise(resolve => {
    blocker.once('error', () => resolve(false));
    blocker.listen(PORT, HOST, () => resolve(true));
  });

  try {
    const root = path.join(__dirname, '..', '..');
    const child = spawn(process.execPath, [path.join(root, 'dist', 'server.js')], {
      env:{ ...process.env, HABIBI_ROOT:root },
      stdio:['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });

    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
      // If the guard regresses the process stays up, so fail rather than hang.
      setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the service kept running despite the port conflict')); }, 15_000).unref();
    });

    assert.equal(code, 1, 'the service should exit non-zero');
    assert.match(output, /EADDRINUSE/);
    assert.match(output, /already running/);
  } finally {
    if (ownsPort) await new Promise(resolve => blocker.close(resolve));
  }
});

// PORT is a hardcoded constant (see the test above), so every test in this
// file that spawns a real server must run in this same file, not a separate
// one — node:test runs distinct test files as concurrent subprocesses, and two
// files each spawning their own server on the same fixed port would race for
// it. Within one file, node:test runs tests sequentially by default, so this
// is safe as long as nothing here is written to run in parallel.
const withServer = async run => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-calendar-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'dist', 'server.js')], {
    env:{ ...process.env, HABIBI_ROOT:root },
    stdio:['ignore', 'ignore', 'ignore'],
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      const check = setInterval(() => {
        fetch(`http://${HOST}:${PORT}/`).then(() => { clearInterval(check); resolve(); }).catch(() => {});
      }, 50);
      setTimeout(() => { clearInterval(check); reject(new Error('server did not start in time')); }, 10_000).unref();
    });
    await run();
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(root, { recursive:true, force:true });
  }
};

// Calendar's actual write path shells out to Calendar.app over JXA, which
// needs a real calendar on the runner and previously took 90+ seconds to even
// READ a 14-day window (see server.js's own comment on why there is no read
// route) — so this only proves the approval gate rejects a bad/missing token
// BEFORE any AppleScript runs, not that a well-formed request successfully
// creates an event.
test('calendar/event routes reject a missing or mismatched approval token before touching Calendar.app', async () => {
  await withServer(async () => {
    const event = { title:'Standup', calendar:'Work', start:'2026-08-05T09:00:00.000Z', end:'2026-08-05T09:15:00.000Z' };

    const noToken = await fetch(`http://${HOST}:${PORT}/api/calendar/event`, {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(event),
    }).then(response => response.json());
    assert.equal(noToken.ok, false);
    assert.match(noToken.error, /approval/i);

    const badToken = await fetch(`http://${HOST}:${PORT}/api/calendar/event`, {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ ...event, approvalToken:'not-a-real-token' }),
    }).then(response => response.json());
    assert.equal(badToken.ok, false);

    const update = { id:'evt-1', title:'Standup', calendar:'Work', start:event.start, end:event.end };
    const noTokenUpdate = await fetch(`http://${HOST}:${PORT}/api/calendar/event/update`, {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(update),
    }).then(response => response.json());
    assert.equal(noTokenUpdate.ok, false);
    assert.match(noTokenUpdate.error, /approval/i);
  });
});

test('there is no HTTP route for reading calendar events — the native app uses EventKit instead', async () => {
  // Regression test for the exact bug this once was: a route that shelled out
  // to a helper binary (bin/calendar-events) that was never committed. Reading
  // now deliberately has no HTTP route at all — asserting its absence keeps
  // anyone from re-adding a route pointed at a script that doesn't exist.
  await withServer(async () => {
    const response = await fetch(`http://${HOST}:${PORT}/api/calendar/events`);
    assert.equal(response.status, 404);
  });
});
