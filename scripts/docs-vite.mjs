import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Invoked in a temporary copy of the pinned Dory package. Inline Vite options
// keep dependency/config caches out of the installed package and pnpm store.
const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const vite = await import(pathToFileURL(require.resolve('vite')).href);
const mode = process.argv[2];
const config = {
  root,
  configFile: path.join(root, mode === 'ssr' ? 'vite.config.ssr.ts' : 'vite.config.ts'),
  configLoader: 'runner',
  cacheDir: path.join(root, '.vite'),
};
if (mode === 'dev') {
  config.plugins = [
    {
      name: 'habibi-docs-reload',
      handleHotUpdate(context) {
        if (!context.file.startsWith(path.join(root, 'docs') + path.sep)) return;
        // Published Dory caches the current MDX component across hot updates.
        // Reload the page after invalidation so content and navigation stay in sync.
        context.server.ws.send({ type: 'full-reload' });
        return [];
      },
    },
  ];
}
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be between 1 and 65535.');
if (mode === 'build' || mode === 'ssr') await vite.build(config);
else if (mode === 'dev') {
  const server = await vite.createServer({ ...config, server: { host: '127.0.0.1', port } });
  await server.listen();
  server.printUrls();
} else if (mode === 'preview') {
  const server = await vite.preview({ ...config, preview: { host: '127.0.0.1', port } });
  server.printUrls();
} else throw new Error(`Unsupported documentation mode: ${mode}`);
