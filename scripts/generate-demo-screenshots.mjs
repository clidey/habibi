#!/usr/bin/env node
/**
 * Capture Habibi's real UI using a sealed, fictional demo route. No desktop,
 * account, connector, or local-file data participates in these screenshots.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const output = join(root, 'docs', 'screenshots');
const port = 4198;
const rendererName = 'habibi-render-page';
const rendererDirectory = join(tmpdir(), 'habibi-demo-render-bin');
const renderer = join(rendererDirectory, rendererName);
const swiftModuleCache = join(tmpdir(), 'habibi-demo-swift-module-cache');
const compatibleSdk = '/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk';
mkdirSync(output, { recursive: true });
mkdirSync(rendererDirectory, { recursive: true });
mkdirSync(swiftModuleCache, { recursive: true });
// WebKit derives a per-process cache directory from the executable name.
// Keep that separate from the binary itself so macOS does not emit a harmless
// “not a directory” diagnostic while producing README assets.
mkdirSync(join(tmpdir(), rendererName), { recursive: true });

execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', join(root, 'tsconfig.json')], {
  stdio: 'inherit',
});
execFileSync('node', [join(root, 'scripts/build-client.mjs')], { cwd: root, stdio: 'inherit' });
const swiftArgs = ['-O', '-module-cache-path', swiftModuleCache];
if (existsSync(compatibleSdk)) swiftArgs.push('-sdk', compatibleSdk);
swiftArgs.push(join(root, 'scripts/render-svg.swift'), '-o', renderer);
execFileSync('swiftc', swiftArgs, { stdio: 'inherit' });

const service = spawn('node', [join(root, 'dist/server.js')], {
  cwd: root,
  env: {
    ...process.env,
    HABIBI_ROOT: root,
    HABIBI_DATA_ROOT: join(tmpdir(), 'habibi-demo-data'),
    HABIBI_PORT: String(port),
  },
  stdio: 'ignore',
});
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const url = `http://127.0.0.1:${port}`;
try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      if ((await fetch(url)).ok) break;
    } catch (_) {
      /* wait for local service */
    }
    await sleep(100);
  }
  const shots = [
    ['daily-briefing', 'briefing'],
    ['launcher-search', 'search'],
    ['preferences', 'preferences'],
  ];
  for (const [name, demo] of shots) {
    const file = join(output, `${name}.png`);
    const uncropped = join(output, `${name}.uncropped.png`);
    const flattenedJpeg = join(output, `${name}.flattened.jpg`);
    const flattenedPng = join(output, `${name}.flattened.png`);
    execFileSync(renderer, [`${url}/?demo=${demo}`, uncropped, '1024', '720'], {
      stdio: 'inherit',
    });
    // WKWebView adds a 16px native host scrollbar gutter outside the document
    // in a headless snapshot. Crop that host-only column from the README asset.
    // WebKit can leave a one-pixel compositor fringe around snapshots. Trim it
    // before flattening so published demo images have a clean opaque edge.
    execFileSync(
      'sips',
      ['--cropToHeightWidth', '720', '988', '--cropOffset', '0', '0', uncropped, '--out', file],
      { stdio: 'ignore' },
    );
    // WebKit outputs a transparent PNG even after painting an opaque page.
    // Round-trip through the macOS image encoder at maximum quality to emit a
    // true RGB PNG; otherwise some viewers matte its transparent gutter white.
    execFileSync(
      'sips',
      ['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', file, '--out', flattenedJpeg],
      { stdio: 'ignore' },
    );
    execFileSync('sips', ['-s', 'format', 'png', flattenedJpeg, '--out', flattenedPng], {
      stdio: 'ignore',
    });
    renameSync(flattenedPng, file);
    rmSync(uncropped, { force: true });
    rmSync(flattenedJpeg, { force: true });
    console.log(`Generated docs/screenshots/${name}.png`);
  }
} finally {
  service.kill();
  rmSync(renderer, { force: true });
}
