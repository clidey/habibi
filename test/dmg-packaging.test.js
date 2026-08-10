const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// This file compiles to dist/test/, two levels below the repository root.
const signScript = fs.readFileSync(path.join(__dirname, '..', '..', 'native/sign-app.sh'), 'utf8');

test('release DMGs use LZMA compression', () => {
  assert.match(
    signScript,
    /hdiutil create[^\n]*-format ULMO -quiet "\$DMG"/,
    'the release image must retain the size-efficient ULMO format'
  );
  assert.doesNotMatch(
    signScript,
    /hdiutil create[^\n]*-format UDZO/,
    'release packaging must not silently fall back to zlib compression'
  );
});

test('release DMGs use the application architecture in their filename', () => {
  assert.match(signScript, /DMG_ARCH="\$\{HABIBI_APP_ARCH:-\$\{HABIBI_OPENWA_ARCH:-\}\}"/);
  assert.match(signScript, /DMG_SUFFIX="\$\{DMG_ARCH:\+-\$DMG_ARCH\}"/);
});
