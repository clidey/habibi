// CI smoke test for a built Habibi app (macOS, Windows, Linux).
//
//   node scripts/ci/smoke-app.mjs --app <executable> --out <dir> [--app-root <dir>]
//
// Launches the app against a throwaway data folder and waits until the UI's
// first `/api` call has been answered by the Rust backend over IPC (which
// proves the page loaded, the bridge works and the services start). On macOS
// it also checks the launcher became a key-capable panel. Then it saves a
// screenshot of the screen/window, checks nothing panicked, and stops the app.
// Requires a debug build: the request/panel logs are debug-only.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []),
);
if (!args.app || !args.out) {
  console.error('usage: smoke-app.mjs --app <executable> --out <dir> [--app-root <dir>]');
  process.exit(2);
}
const out = path.resolve(args.out);
await fs.mkdir(out, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'habibi-smoke-'));
const logFile = path.join(out, `app-${process.platform}.log`);
const env = {
  ...process.env,
  HABIBI_DATA_ROOT: data,
  HABIBI_API_LOG: '1',
  HABIBI_SHELL_LOG: '1',
  // Never send product analytics from CI.
  HABIBI_POSTHOG_HOST: 'http://127.0.0.1:9',
  ...(args['app-root'] ? { HABIBI_APP_ROOT: path.resolve(args['app-root']) } : {}),
};

let log = '';
let exited = null;
const child = spawn(path.resolve(args.app), [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (chunk) => (log += chunk));
child.stderr.on('data', (chunk) => (log += chunk));
child.on('exit', (code, signal) => (exited = { code, signal }));

const waitFor = async (label, test, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (test()) return;
    if (exited) throw new Error(`the app exited (${JSON.stringify(exited)}) before ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const screenshot = async () => {
  const file = path.join(out, `app-${process.platform}.png`);
  try {
    if (process.platform === 'darwin') {
      const id = execFileSync('swift', [path.join(import.meta.dirname, 'window-id.swift'), String(child.pid)], { encoding: 'utf8' }).trim();
      execFileSync('screencapture', ['-x', '-o', '-l', id, file]);
    } else if (process.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
        '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
        '$i = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
        '$g = [System.Drawing.Graphics]::FromImage($i)',
        '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $i.Size)',
        `$i.Save('${file.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      ].join('; ');
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    } else {
      execFileSync('import', ['-window', 'root', file]);
    }
    console.log(`screenshot: ${file}`);
  } catch (error) {
    // Screenshots are for review only; a missing one must not fail the build.
    console.warn(`screenshot unavailable: ${error.message.split('\n')[0]}`);
  }
};

let failure = null;
try {
  await waitFor('the UI to reach Rust (GET /api/mail/status)', () => /\[api\] Get \/api\/mail\/status -> 200 ok=Some\(true\)/.test(log), 120_000);
  if (process.platform === 'darwin') {
    await waitFor('the launcher panel report', () => /\[panel\] launcher /.test(log), 30_000);
    const panel = log.match(/\[panel\] launcher .*/)[0];
    if (!/class=LauncherPanel/.test(panel) || !/key=true/.test(panel)) throw new Error(`the launcher is not a key panel: ${panel}`);
  }
  // Let the first-run screen settle, then capture it.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  if (exited) throw new Error(`the app exited early (${JSON.stringify(exited)})`);
  await screenshot();
  if (/panicked at|thread '.*' panicked/.test(log)) throw new Error('the app panicked');
} catch (error) {
  failure = error;
} finally {
  if (!exited) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { /* already gone */ }
    } else {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (!exited) child.kill('SIGKILL');
    }
  }
  await fs.writeFile(logFile, log);
  await fs.rm(data, { recursive: true, force: true });
}
if (failure) {
  console.error(`smoke test failed: ${failure.message}\n--- last log lines ---\n${log.split('\n').slice(-40).join('\n')}`);
  process.exit(1);
}
const calls = [...new Set(log.match(/\[api\] .*/g) || [])];
console.log(`smoke test passed on ${process.platform}; API calls answered:\n  ${calls.join('\n  ')}`);
