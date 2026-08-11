const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..', '..');
const bundlePath = path.join(root, 'dist', 'server.bundle.js');

test('the production server is bundled without unused provider SDKs', () => {
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  assert.ok(bundle.length > 0, 'build:server must emit the production bundle');
  assert.doesNotMatch(bundle, /require\(["'](?:@mistralai|@aws-sdk|@opentelemetry)\//);
  assert.match(bundle, /require\(["']node-pty["']\)/, 'native node-pty must remain a runtime external');
});
