const net = require('node:net');
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
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(PORT, HOST, resolve);
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
    await new Promise(resolve => blocker.close(resolve));
  }
});
