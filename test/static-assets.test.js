const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveStaticAsset, staticContentType } = require('../src/core/static-assets');

const root = '/workspace/habibi';

test('the static handler serves only the launcher assets', () => {
  for (const asset of [
    '/',
    '/index.html',
    '/app.css',
    '/assets/app.bundle.js',
    '/assets/logo.png',
  ]) {
    assert.notEqual(resolveStaticAsset(asset, root), null, `${asset} should be served`);
  }
  assert.equal(resolveStaticAsset('/', root), path.join(root, 'index.html'));
});

test('local secrets and source files are never reachable over HTTP', () => {
  // Everything here previously resolved: the workspace root holds provider
  // secrets, OpenWA session keys and the source tree beside the served assets.
  const blocked = [
    '/.habibi/mail-providers.json',
    '/.habibi/llm-config.json',
    '/.habibi/imported-skill-audit.jsonl',
    '/.openwa/data/.api-key',
    '/.env',
    '/package.json',
    '/pnpm-lock.yaml',
    '/server.js',
    '/app.js',
    '/.git/config',
    '/src/core/approval-service.js',
    '/native/HabibiApp.swift',
    '/skills/whatsapp/manifest.json',
  ];
  for (const target of blocked)
    assert.equal(resolveStaticAsset(target, root), null, `${target} must not be served`);
});

test('traversal attempts cannot escape the workspace root', () => {
  for (const target of [
    '/../secrets.json',
    '/../../etc/passwd',
    '/%2e%2e/secrets.json',
    '//../secrets.json',
    '/assets/../../.env',
  ]) {
    assert.equal(resolveStaticAsset(target, root), null, `${target} must not resolve`);
  }
  // A sibling directory sharing the root's prefix must not pass containment.
  assert.equal(
    resolveStaticAsset('/index.html', '/workspace/habibi'),
    '/workspace/habibi/index.html',
  );
  assert.equal(resolveStaticAsset('/../habibi-secrets/keys.json', root), null);
});

test('served assets declare an accurate content type', () => {
  assert.equal(staticContentType('/index.html'), 'text/html');
  assert.equal(staticContentType('/app.css'), 'text/css');
  assert.equal(staticContentType('/assets/app.bundle.js'), 'text/javascript');
  // The logo was previously sent as application/octet-stream.
  assert.equal(staticContentType('/assets/logo.png'), 'image/png');
});
