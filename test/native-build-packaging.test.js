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

test('no-WhatsApp builds are thin for releases and universal by default locally', () => {
  assert.match(buildScript, /arm64\) NODE_ARCHES=\(arm64\); SERVICE_PREBUILD_ARCHES=\(darwin-arm64\)/);
  assert.match(buildScript, /x64\) NODE_ARCHES=\(x64\); SERVICE_PREBUILD_ARCHES=\(darwin-x64\)/);
  assert.match(buildScript, /universal\) NODE_ARCHES=\(arm64 x64\); SERVICE_PREBUILD_ARCHES=\(darwin-arm64 darwin-x64\)/);
  assert.match(
    buildScript,
    /lipo -create "\$NODE_CACHE\/node-arm64" "\$NODE_CACHE\/node-x64" -output "\$CONTENTS\/MacOS\/node"/
  );
  assert.match(buildScript, /if \[\[ -n "\$\{HABIBI_APP_ARCH:-\}" \]\]; then/);
});

test('WhatsApp components retain only English Chromium localization bundles', () => {
  assert.match(buildScript, /-name "\*\.lproj" ! -name "en\*\.lproj" -prune -exec rm -rf \{\} \+/);
  assert.match(buildScript, /-name "en\*\.lproj" -print -quit/);
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
