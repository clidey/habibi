// CI check of an installed or unpacked Habibi bundle.
//
//   node scripts/ci/check-bundle.mjs <bundle or install directory>
//
// Finds the resource root (the directory holding index.html) and checks the
// app ships what the shell serves, and nothing it must not: no Node runtime
// (WhatsApp brings its own component), no source maps or type declarations,
// no local state. Prints the resource root on success, for --app-root.
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('usage: check-bundle.mjs <directory>');
  process.exit(2);
}

const files = [];
const walk = async (directory, depth = 0) => {
  if (depth > 12) return;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(target, depth + 1);
    else if (entry.isFile()) files.push(target);
  }
};
await walk(root);
const relative = (file) => path.relative(root, file).split(path.sep).join('/');

const problems = [];
const index = files.filter((file) => path.basename(file) === 'index.html').sort((a, b) => a.length - b.length)[0];
if (!index) problems.push('no index.html (the UI is not bundled)');
const resourceRoot = index ? path.dirname(index) : root;
const inResources = (name) => files.some((file) => relative(file) === relative(path.join(resourceRoot, name)));
for (const required of ['app.css', 'assets/app.bundle.js', 'assets/ux.bundle.js', 'assets/styles/ux.css', 'assets/vendor/xterm.js', 'assets/logo.png']) {
  if (!inResources(required)) problems.push(`missing ${required}`);
}
const manifests = files.filter((file) => /[\\/]skills[\\/][^\\/]+[\\/]manifest\.json$/.test(file));
if (manifests.length === 0) problems.push('no skills/*/manifest.json');

const forbidden = [
  [/(^|\/)node(\.exe)?$/i, 'a Node runtime'],
  [/\.map$/, 'a source map'],
  [/\.d\.ts$/, 'a TypeScript declaration'],
  [/(^|\/)\.(habibi|openwa)(\/|$)/, 'local state'],
  [/(^|\/)openwa-supervisor\.js$/, 'the OpenWA supervisor (it belongs to the WhatsApp component)'],
];
for (const file of files) {
  const name = relative(file);
  for (const [pattern, what] of forbidden) if (pattern.test(name)) problems.push(`${what}: ${name}`);
}

const bytes = (await Promise.all(files.map((file) => fs.stat(file).then((stat) => stat.size)))).reduce((a, b) => a + b, 0);
if (problems.length) {
  console.error(`bundle check failed for ${root}:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.error(`bundle ok: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, ${manifests.length} skills`);
console.log(resourceRoot);
