const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// This file compiles to dist/test/, two levels below the repository root.
const signScript = fs.readFileSync(path.join(__dirname, '..', '..', 'native/sign-app.sh'), 'utf8');
const smokeScript = fs.readFileSync(
  path.join(__dirname, '..', '..', 'native/smoke-test-release.sh'),
  'utf8',
);

test('release DMGs use zlib compression, not LZMA', () => {
  // ULMO (LZMA) shrinks the download but was too slow/unreliable to CREATE on
  // a Chromium-sized bundle on GitHub's macOS runners: a real release run saw
  // hdiutil create -format ULMO run 70+ seconds with zero output, and its
  // diskimages-helper process was still alive and had to be force-reaped when
  // the job gave up — no real hdiutil error was ever printed. UDZO trades a
  // somewhat larger download for CI that reliably finishes.
  assert.match(
    signScript,
    /hdiutil create[^\n]*-format UDZO -quiet "\$DMG"/,
    'the release image must use UDZO — ULMO caused a CI hang, see the comment above',
  );
  assert.doesNotMatch(
    signScript,
    /hdiutil create[^\n]*-format ULMO/,
    'release packaging must not switch back to ULMO without addressing the CI hang first',
  );
});

test('release DMGs use the application architecture in their filename', () => {
  assert.match(signScript, /DMG_ARCH="\$\{HABIBI_APP_ARCH:-\$\{HABIBI_OPENWA_ARCH:-\}\}"/);
  assert.match(signScript, /DMG_SUFFIX="\$\{DMG_ARCH:\+-\$DMG_ARCH\}"/);
});

test('release smoke tests execute the pruned terminal runtime', () => {
  assert.match(smokeScript, /require\("node-pty"\)/);
  assert.match(smokeScript, /habibi-pty-smoke/);
});
