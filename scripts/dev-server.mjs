// Starts `habibi-devserver` (crates/habibi-devserver) for Playwright scripts:
// the launcher UI and the Rust `/api/*` routes on 127.0.0.1, with isolated
// state. Builds the binary once per process; set HABIBI_DEVSERVER_BIN to
// reuse a binary that is already built.
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let binary = process.env.HABIBI_DEVSERVER_BIN || '';

export function buildDevServer() {
  if (binary) return binary;
  const build = spawnSync(
    'cargo',
    ['build', '-p', 'habibi-devserver', '--bin', 'habibi-devserver', '--message-format=json-render-diagnostics'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
  );
  if (build.status !== 0) throw new Error('cargo build -p habibi-devserver failed.');
  for (const line of build.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    const message = JSON.parse(line);
    if (message.reason === 'compiler-artifact' && message.target?.name === 'habibi-devserver' && message.executable)
      binary = message.executable;
  }
  if (!binary) throw new Error('cargo did not report the habibi-devserver binary.');
  return binary;
}

export async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * @param {{ dataRoot: string, home?: string, port?: number, appRoot?: string }} options
 * `dataRoot` is required and must be a scratch directory. `home` defaults to
 * `<dataRoot>/home` inside the server, so file search never sees real files.
 */
export async function startDevServer({ dataRoot, home, port, appRoot = root }) {
  if (!dataRoot) throw new Error('startDevServer needs a scratch dataRoot.');
  const executable = buildDevServer();
  port ||= await freePort();
  const env = { ...process.env, HABIBI_PORT: String(port), HABIBI_ROOT: appRoot, HABIBI_DATA_ROOT: dataRoot };
  if (home) env.HABIBI_HOME = home;
  else delete env.HABIBI_HOME;
  const child = spawn(executable, [], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', (chunk) => {
    log = (log + chunk).slice(-4000);
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await exited;
  };
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(`habibi-devserver exited (${child.exitCode}): ${log.trim()}`);
    try {
      if ((await fetch(url)).ok) return { url, port, stop, child };
    } catch {
      /* Wait for the isolated server. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error(`habibi-devserver did not become ready on ${url}: ${log.trim()}`);
}
