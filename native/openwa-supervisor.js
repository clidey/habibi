'use strict';

const { spawn } = require('node:child_process');

const entrypoint = process.argv[2];
const parentPid = Number.parseInt(process.env.HABIBI_PARENT_PID || '', 10);

if (
  !entrypoint ||
  !Number.isSafeInteger(parentPid) ||
  parentPid <= 1 ||
  process.ppid !== parentPid
) {
  process.stderr.write('OpenWA supervisor requires its live Habibi parent.\n');
  process.exit(1);
}

// Give OpenWA and Chromium their own process group. That lets the supervisor
// terminate the whole feature, rather than leaving Chromium grandchildren
// behind when Habibi crashes or is force-killed.
const child = spawn(process.execPath, [entrypoint], {
  detached: true,
  env: process.env,
  stdio: 'inherit',
});

let stopping = false;
let forceTimer;

function signalGroup(signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {}
}

function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(parentWatch);
  signalGroup('SIGTERM');
  forceTimer = setTimeout(() => {
    signalGroup('SIGKILL');
    process.exit(1);
  }, 2_000);
  forceTimer.unref();
}

const parentWatch = setInterval(() => {
  // A dead parent is reaped and this process is reparented. Checking both the
  // recorded PID and PPID also avoids accepting an unrelated reused PID.
  try {
    process.kill(parentPid, 0);
    if (process.ppid !== parentPid) stop();
  } catch {
    stop();
  }
}, 250);
parentWatch.unref();

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);

child.once('error', (error) => {
  process.stderr.write(`Could not start OpenWA: ${error.message}\n`);
  process.exit(1);
});
child.once('exit', (code, signal) => {
  clearInterval(parentWatch);
  if (forceTimer) clearTimeout(forceTimer);
  process.exit(stopping ? 0 : (code ?? (signal ? 1 : 0)));
});
