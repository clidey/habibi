import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { docs, doryRoot, excluded, repository } from './docs-project.mjs';

const mode = process.argv[2];
if (!['dev', 'build', 'preview'].includes(mode))
  throw new Error('Use docs:dev, docs:build, or docs:preview.');
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'habibi-dory-'));
class Interrupted extends Error {}
let watcher;
const refresh = new Map();
let syncing = Promise.resolve();
async function syncDoc(file) {
  const source = path.join(docs, file);
  const destination = path.join(workspace, 'docs', file);
  let stat;
  try {
    stat = await fs.lstat(source);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.rm(destination, { recursive: true, force: true });
    return;
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing a docs symlink: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const name of await fs.readdir(source)) {
      if (!excluded.has(name) && !name.startsWith('.')) await syncDoc(path.join(file, name));
    }
    return;
  }
  // An atomic replacement keeps Vite from seeing empty or partially copied MDX.
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination), `.${path.basename(file)}.tmp`);
  await fs.writeFile(temporary, await fs.readFile(source));
  await fs.rename(temporary, destination);
}
async function stageDocs() {
  const destination = path.join(workspace, 'docs');
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(docs, destination, {
    recursive: true,
    filter: async (candidate) => {
      const name = path.basename(candidate);
      if (candidate !== docs && (excluded.has(name) || name.startsWith('.'))) return false;
      if ((await fs.lstat(candidate)).isSymbolicLink())
        throw new Error(`Refusing a docs symlink: ${candidate}`);
      return true;
    },
  });
}
async function run(script, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: workspace,
    stdio: 'inherit',
    env: process.env,
  });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(signal ? 130 : code));
    });
    if (code === 130) throw new Interrupted();
    if (code !== 0) throw new Error(`Documentation ${mode} exited with ${code}.`);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
try {
  for (const name of [
    'src',
    'scripts',
    'bin',
    'index.html',
    'package.json',
    'vite.config.ts',
    'vite.config.ssr.ts',
  ]) {
    await fs.cp(path.join(doryRoot, name), path.join(workspace, name), { recursive: true });
  }
  const dependencyDirectory = path.resolve(doryRoot, '../..');
  await fs.access(path.join(dependencyDirectory, 'vite'));
  await fs.symlink(dependencyDirectory, path.join(workspace, 'node_modules'), 'dir');
  await stageDocs();
  const template = path.join(workspace, 'index.html');
  await fs.writeFile(
    template,
    (await fs.readFile(template, 'utf8')).replace(
      '</head>',
      '  <link rel="stylesheet" href="/docs/site.css" />\n</head>',
    ),
  );
  const vite = path.join(repository, 'scripts/docs-vite.mjs');
  if (mode === 'build') {
    await run(vite, ['build']);
    await run(vite, ['ssr']);
    await run(path.join(workspace, 'scripts/render-routes.mjs'));
    const generated = path.join(workspace, 'dist');
    await fs.access(path.join(generated, 'index.html'));
    const output = path.join(docs, 'dist');
    await fs.rm(output, { recursive: true, force: true });
    await fs.cp(generated, output, { recursive: true });
    console.log(`Habibi documentation built in ${output}`);
  } else if (mode === 'preview') {
    await fs.access(path.join(docs, 'dist/index.html'));
    await fs.symlink(path.join(docs, 'dist'), path.join(workspace, 'dist'), 'dir');
    await run(vite, ['preview']);
  } else {
    watcher = watch(docs, { recursive: true }, (_event, file) => {
      if (!file || file.split(path.sep).some((part) => excluded.has(part) || part.startsWith('.')))
        return;
      clearTimeout(refresh.get(file));
      refresh.set(
        file,
        setTimeout(() => {
          refresh.delete(file);
          syncing = syncing
            .then(() => syncDoc(file))
            .catch((error) => console.error(error.message));
        }, 150),
      );
    });
    await run(vite, ['dev']);
  }
} catch (error) {
  if (error instanceof Interrupted) process.exitCode = 130;
  else throw error;
} finally {
  for (const timer of refresh.values()) clearTimeout(timer);
  watcher?.close();
  await syncing;
  await fs.rm(workspace, { recursive: true, force: true });
}
