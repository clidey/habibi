import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

// The launcher UI is one ES module graph rooted at app.js. Bundling it lets the
// client import real npm packages (escaping, sanitizing) instead of carrying
// hand-written copies, and means the browser no longer fetches the source tree.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await esbuild.build({
  entryPoints:[path.join(root, 'app.js')],
  outfile:path.join(root, 'assets', 'app.bundle.js'),
  bundle:true,
  format:'esm',
  platform:'browser',
  target:['safari17'],
  sourcemap:true,
  logLevel:'info',
});
