'use strict';

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const windows = process.platform === 'win32';

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
// behind when Habibi crashes or is force-killed. Windows has no process
// groups (and `detached` there means a new console window), so the tree is
// ended with taskkill instead; Habibi also starts this supervisor inside a
// kill-on-close Job Object that OpenWA and Chromium inherit, which ends the
// tree when Habibi dies. That job permits no breakaway, so nothing started
// from here can leave it.
const child = spawn(process.execPath, [entrypoint], {
  detached: !windows,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});

let stopping = false;
let forceTimer;

function signalGroup(signal) {
  if (!child.pid) return;
  if (windows) {
    // Console processes ignore taskkill's polite close, so both the stop and
    // the forced follow-up end OpenWA and its Chromium children outright.
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
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
