const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// This file compiles to dist/test/, two levels below the repository root.
const buildScript = fs.readFileSync(
  path.join(__dirname, '..', '..', 'native/build-app.sh'),
  'utf8',
);
const nativeSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'native/HabibiApp.swift'),
  'utf8',
);

test('WhoDB credentials use a signed native helper bundled for both launcher architectures', () => {
  assert.match(buildScript, /native\/HabibiKeychain\.swift[\s\S]*?MacOS\/HabibiKeychain/);
  assert.match(buildScript, /lipo -create[^\n]*HabibiKeychain-arm64[^\n]*HabibiKeychain-x86_64/);
  assert.match(buildScript, /codesign[^\n]*SIGNING_IDENTITY[^\n]*MacOS\/HabibiKeychain/);
  assert.match(nativeSource, /HABIBI_KEYCHAIN_HELPER[^\n]*Contents\/MacOS\/HabibiKeychain/);
});

test('build and release signing finish the Keychain helper before signing the main executable', () => {
  const signScript = fs.readFileSync(path.join(__dirname, '..', '..', 'native/sign-app.sh'), 'utf8');
  const helperSigning = buildScript.indexOf('--options runtime "$CONTENTS/MacOS/HabibiKeychain"');
  const mainSigning = buildScript.indexOf('--options runtime "$CONTENTS/MacOS/Habibi"');
  assert.ok(helperSigning > 0 && helperSigning < mainSigning, 'the main executable validates its bundle, so nested helpers must already be signed');
  const releaseHelperSigning = signScript.indexOf('sign_nested_executable "$APP/Contents/MacOS/HabibiKeychain"');
  const releaseMainSigning = signScript.indexOf('"$APP/Contents/MacOS/Habibi"');
  assert.ok(releaseHelperSigning > 0 && releaseHelperSigning < releaseMainSigning, 'the release helper must be re-signed with the distribution identity before the main executable');
});

test('WhatsApp builds keep only their target Node architecture', () => {
  assert.match(buildScript, /arm64\)\s*\n\s*NODE_ARCHES=\(arm64\)/);
  assert.match(buildScript, /x64\)\s*\n\s*NODE_ARCHES=\(x64\)/);
  assert.match(
    buildScript,
    /cp "\$NODE_CACHE\/node-\$\{NODE_ARCHES\[1\]\}" "\$CONTENTS\/MacOS\/node"/,
  );
});

test('no-WhatsApp builds are thin for releases and universal by default locally', () => {
  assert.match(
    buildScript,
    /arm64\) NODE_ARCHES=\(arm64\); SERVICE_PREBUILD_ARCHES=\(darwin-arm64\)/,
  );
  assert.match(buildScript, /x64\) NODE_ARCHES=\(x64\); SERVICE_PREBUILD_ARCHES=\(darwin-x64\)/);
  assert.match(
    buildScript,
    /universal\) NODE_ARCHES=\(arm64 x64\); SERVICE_PREBUILD_ARCHES=\(darwin-arm64 darwin-x64\)/,
  );
  assert.match(
    buildScript,
    /lipo -create "\$NODE_CACHE\/node-arm64" "\$NODE_CACHE\/node-x64" -output "\$CONTENTS\/MacOS\/node"/,
  );
  assert.match(buildScript, /if \[\[ -n "\$\{HABIBI_APP_ARCH:-\}" \]\]; then/);
});

test('Node downloads retry transient failures before extracting a complete archive', () => {
  const download = buildScript.indexOf('curl --http1.1');
  const extraction = buildScript.indexOf('tar xzf "$NODE_ARCHIVE"');
  assert.ok(download > 0 && extraction > download);
  assert.match(buildScript, /--retry 4 --retry-all-errors/);
  assert.match(buildScript, /--output "\$NODE_ARCHIVE"/);
});

test('WhatsApp components retain only English Chromium localization bundles', () => {
  assert.match(buildScript, /-name "\*\.lproj" ! -name "en\*\.lproj" -prune -exec rm -rf \{\} \+/);
  assert.match(buildScript, /-name "en\*\.lproj" -print -quit/);
});

test('WhatsApp components discard TypeScript build-only artifacts', () => {
  assert.match(buildScript, /-name "\*\.map" -o -name "\*\.d\.ts" -o -name "\*\.tsbuildinfo"/);
});

test('native builds include the OpenWA parent-liveness supervisor', () => {
  assert.match(
    buildScript,
    /cp native\/openwa-supervisor\.js "\$CONTENTS\/Resources\/openwa-supervisor\.js"/,
  );
});

test('native builds retain only node-pty macOS runtime files', () => {
  for (const directory of ['deps', 'scripts', 'src', 'third_party', 'typings']) {
    assert.match(buildScript, new RegExp(`node-pty/${directory}`));
  }
  assert.match(buildScript, /find "\$SERVICE\/node_modules\/node-pty\/lib"/);
  assert.match(buildScript, /-name "\*\.map" -o -name "\*\.test\.js"/);
});

test('native builds create ICNS deterministically without macOS 26 iconutil', () => {
  assert.match(
    buildScript,
    /node scripts\/build-icns\.mjs "\$ICONSET" "\$CONTENTS\/Resources\/Habibi\.icns"/,
  );
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

test('native startup probes the local service immediately without overlapping requests', () => {
  assert.match(nativeSource, /pollUntilAvailable\(deadline: Date\(\)\.addingTimeInterval\(10\)\)/);
  assert.match(nativeSource, /scheduledTimer\(withTimeInterval: 0\.1, repeats: false\)/);
  assert.doesNotMatch(
    nativeSource,
    /scheduledTimer\(withTimeInterval: 0\.25, repeats: true\)[\s\S]*?pollService/,
  );
});

test('global shortcut registration survives wake and session unlock', () => {
  assert.match(nativeSource, /NSWorkspace\.didWakeNotification/);
  assert.match(nativeSource, /NSWorkspace\.sessionDidBecomeActiveNotification/);
  assert.match(nativeSource, /private var hotKeyEventHandler: EventHandlerRef\?/);
  assert.match(nativeSource, /guard hotKeyEventHandler == nil else \{ return true \}/);
  assert.match(nativeSource, /if shortcut == launcherShortcut\(\), hotKey != nil/);
});

test('AppKit clips the web surface to one rounded launcher boundary', () => {
  assert.match(nativeSource, /container\.wantsLayer = true/);
  assert.match(nativeSource, /container\.layer\?\.cornerRadius = 18/);
  assert.match(nativeSource, /container\.layer\?\.masksToBounds = true/);
});

test('explicit local WhatsApp components are signature-verified before bundling', () => {
  const start = buildScript.indexOf('if [[ -n "${HABIBI_LOCAL_WHATSAPP_COMPONENT:-}" ]]');
  assert.ok(start >= 0);
  const block = buildScript.slice(start, buildScript.indexOf('elif [[', start));
  assert.match(block, /HABIBI_SKIP_OPENWA/);
  const verification = block.indexOf('codesign --verify --deep --strict');
  const copying = block.indexOf('ditto "$LOCAL_OPENWA"');
  assert.ok(verification >= 0 && copying > verification);
  assert.match(block, /dist\/main\.js/);
});
