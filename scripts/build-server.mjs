import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await esbuild.build({
  entryPoints: [path.join(root, 'server.js')],
  outfile: path.join(root, 'dist', 'server.bundle.js'),
  bundle: true,
  platform: 'node',
  target: ['node22'],
  format: 'cjs',
  minify: true,
  keepNames: true,
  legalComments: 'eof',
  external: ['node-pty'],
  metafile: true,
  logLevel: 'info',
});

// Native node-pty must remain external. ws and debug probe these optional
// packages inside try/catch blocks and work without them; everything else must
// be bundled so the packaged service cannot acquire an undeclared dependency.
const allowed = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  'node-pty',
  'bufferutil',
  'utf-8-validate',
  'supports-color',
]);
const unexpected = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports || []) {
    if (imported.external && !allowed.has(imported.path)) unexpected.add(imported.path);
  }
}
if (unexpected.size) {
  throw new Error(`Unexpected external server dependencies: ${[...unexpected].sort().join(', ')}`);
}
