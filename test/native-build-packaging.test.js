const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// This file compiles to dist/test/, two levels below the repository root.
const buildScript = fs.readFileSync(path.join(__dirname, '..', '..', 'native/build-app.sh'), 'utf8');

test('WhatsApp builds keep only their target Node architecture', () => {
  assert.match(buildScript, /arm64\)\s*\n\s*NODE_ARCHES=\(arm64\)/);
  assert.match(buildScript, /x64\)\s*\n\s*NODE_ARCHES=\(x64\)/);
  assert.match(buildScript, /cp "\$NODE_CACHE\/node-\$\{NODE_ARCHES\[1\]\}" "\$CONTENTS\/MacOS\/node"/);
});

test('the no-WhatsApp build remains universal', () => {
  assert.match(
    buildScript,
    /HABIBI_SKIP_OPENWA[^\n]*== "1"[^\n]*\n\s*NODE_ARCHES=\(arm64 x64\)\n\s*SERVICE_PREBUILD_ARCHES=\(darwin-arm64 darwin-x64\)/
  );
  assert.match(
    buildScript,
    /lipo -create "\$NODE_CACHE\/node-arm64" "\$NODE_CACHE\/node-x64" -output "\$CONTENTS\/MacOS\/node"/
  );
});

test('native builds create ICNS deterministically without macOS 26 iconutil', () => {
  assert.match(buildScript, /node scripts\/build-icns\.mjs "\$ICONSET" "\$CONTENTS\/Resources\/Habibi\.icns"/);
  assert.doesNotMatch(buildScript, /iconutil -c icns/);
});

test('Swift compilation uses a project-local module cache', () => {
  assert.match(buildScript, /-module-cache-path "\$SWIFT_MODULE_CACHE"/);
});

test('local builds re-sign the lipo-created Node binary before the outer app', () => {
  const nodeSigning = buildScript.indexOf('--options runtime "$CONTENTS/MacOS/node"');
  const appSigning = buildScript.indexOf('--options runtime "$APP"');
  assert.ok(nodeSigning > 0 && appSigning > nodeSigning);
  assert.match(buildScript, /codesign --verify --deep --strict "\$APP"/);
});
