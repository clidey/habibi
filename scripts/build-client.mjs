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

await esbuild.build({
  entryPoints: [path.join(root, 'src/client/features/teleprompter/teleprompter-feature.js')],
  outfile: path.join(root, 'assets/teleprompter.bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['safari17'],
  minify: true,
  sourcemap: true,
  logLevel: 'info',
});

await esbuild.build({
  entryPoints: [path.join(root, 'src/client/features/emoji/emoji-feature.js')],
  outfile: path.join(root, 'assets/emoji.bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['safari17'],
  minify: true,
  sourcemap: true,
  logLevel: 'info',
});

await esbuild.build({
  entryPoints: [path.join(root, 'src/client/features/notes/notes-feature.js')],
  outfile: path.join(root, 'assets/notes.bundle.js'),
  banner: {
    js: `/*! Marked — MIT License\n${(await fs.readFile(path.join(root, 'node_modules/marked/LICENSE'), 'utf8')).replace(/\*\//g, '* /')}\n*/`,
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['safari17'],
  minify: true,
  sourcemap: true,
  logLevel: 'info',
});

await esbuild.build({ entryPoints: [path.join(root, 'src/client/features/daily/daily-feature.js')], outfile: path.join(root, 'assets/daily.bundle.js'), bundle: true, format: 'esm', platform: 'browser', target: ['safari17'], minify: true, sourcemap: true, logLevel: 'info' });

await esbuild.build({ entryPoints: [path.join(root, 'src/client/features/assistant-tools/assistant-tools.js')], outfile: path.join(root, 'assets/assistant-tools.bundle.js'), bundle: true, format: 'esm', platform: 'browser', target: ['safari17'], minify: true, sourcemap: true, logLevel: 'info' });

// Preferences are opened on demand; appearance still applies during startup.
await esbuild.build({
  entryPoints: [path.join(root, 'src/client/features/settings/settings-feature.js')],
  outfile: path.join(root, 'assets/settings.bundle.js'),
  bundle: true, format: 'esm', platform: 'browser', target: ['safari17'],
  minify: true, sourcemap: true, logLevel: 'info',
});

await esbuild.build({ entryPoints: [path.join(root, 'src/client/features/mail/mail-composer.js')], outfile: path.join(root, 'assets/mail-composer.bundle.js'), bundle: true, format: 'esm', platform: 'browser', target: ['safari17'], minify: true, sourcemap: true, logLevel: 'info' });

// Share one published UX runtime across the shell and workspaces. Keep React
// out of app.bundle.js and avoid relying on a sibling checkout at packaging time.
await fs.copyFile(
  path.join(root, 'node_modules/@clidey/ux/dist/styles.css'),
  path.join(root, 'assets/styles/ux.css'),
);
await esbuild.build({
  entryPoints: [path.join(root, 'src/client/ux/components.jsx')],
  outfile: path.join(root, 'assets/ux.bundle.js'),
  bundle: true,
  format: 'iife',
  globalName: 'HabibiUx',
  plugins: [
    {
      name: 'ux-catalog-svg-urls',
      setup(build) {
        build.onLoad({ filter: /\.svg$/ }, async ({ path: iconPath }) => {
          const svg = await fs.readFile(iconPath, 'utf8');
          // CatalogIcon quotes its URL inside CSS masks. Encode SVG quotes and
          // fragment characters so WebKit can parse the embedded URL safely.
          const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
          return { contents: `export default ${JSON.stringify(url)};`, loader: 'js' };
        });
      },
    },
  ],
  platform: 'browser',
  target: ['safari17'],
  minify: true,
  logLevel: 'info',
});
