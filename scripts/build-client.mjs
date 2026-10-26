import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

// The launcher UI is one ES module graph rooted at app.js. Bundling it lets the
// client import real npm packages (escaping, sanitizing) instead of carrying
// hand-written copies, and means the browser no longer fetches the source tree.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(root, 'assets', 'vendor');

// The browser needs three files from packages that are otherwise build-time
// dependencies. Copy only those artifacts into the generated client assets so
// production packaging does not carry the packages' sources, maps, types and
// unused icon modules in node_modules.
const vendorFiles = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'xterm-fit.js'],
];

await fs.rm(vendorRoot, { recursive: true, force: true });
await fs.mkdir(vendorRoot, { recursive: true });
await Promise.all(
  vendorFiles.map(([source, target]) =>
    fs.copyFile(path.join(root, 'node_modules', source), path.join(vendorRoot, target)),
  ),
);

// Bundle only the WhoDB glyphs used by Habibi. The checked-in snapshot keeps
// production builds independent of a sibling WhoDB checkout.
await esbuild.build({
  entryPoints: [path.join(root, 'src/client/core/whodb-icons.js')],
  outfile: path.join(vendorRoot, 'whodb-icons.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['safari17'],
  legalComments: 'eof',
  logLevel: 'info',
});

await esbuild.build({
  entryPoints: [path.join(root, 'app.js')],
  outfile: path.join(root, 'assets', 'app.bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['safari17'],
  minify: true,
  sourcemap: true,
  logLevel: 'info',
});
