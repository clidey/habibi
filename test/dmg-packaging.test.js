const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// This file compiles to dist/test/, two levels below the repository root.
const root = path.join(__dirname, '..', '..');
const signScript = fs.readFileSync(path.join(root, 'native/sign-app.sh'), 'utf8');
const smokeScript = fs.readFileSync(path.join(root, 'native/smoke-test-release.sh'), 'utf8');

test('release DMGs use zlib compression, not LZMA', () => {
  // ULMO (LZMA) shrinks the download but was too slow/unreliable to CREATE on
  // GitHub's macOS runners: a real release run saw hdiutil create -format ULMO
  // run 70+ seconds with zero output, and its diskimages-helper process was
  // still alive and had to be force-reaped when the job gave up — no real
  // hdiutil error was ever printed. UDZO trades a somewhat larger download for
  // CI that reliably finishes.
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

test('release DMGs offer drag-to-install and are signed, notarized and stapled', () => {
  assert.match(signScript, /ln -s \/Applications "\$DMG_ROOT\/Applications"/);
  assert.match(signScript, /codesign --force --sign "\$APPLE_DEVELOPER_ID_APPLICATION" --timestamp "\$DMG"/);
  assert.match(signScript, /notarytool submit "\$DMG"/);
  assert.match(signScript, /stapler staple "\$DMG"/);
  assert.match(signScript, /spctl -a -t open --context context:primary-signature -vv "\$DMG"/);
  // The app-specific password never appears in notarytool's argv.
  assert.doesNotMatch(signScript, /notarytool submit[^\n]*--password/);
});

test('the signed app is checked for hardened runtime, a timestamp and its privacy entitlements', () => {
  assert.match(signScript, /flags=\.\*runtime/);
  assert.match(signScript, /\^Timestamp=/);
  for (const [usage, entitlement] of [
    ['NSCalendarsFullAccessUsageDescription', 'com.apple.security.personal-information.calendars'],
    ['NSContactsUsageDescription', 'com.apple.security.personal-information.addressbook'],
    ['NSMicrophoneUsageDescription', 'com.apple.security.device.audio-input'],
    ['NSSpeechRecognitionUsageDescription', 'com.apple.security.personal-information.speech-recognition'],
  ]) {
    assert.match(signScript, new RegExp(`check_entitlement_pair "${usage}" "${entitlement.replaceAll('.', '\\.')}"`));
  }
});

test('the app carries no JavaScript engine exceptions and no Node', () => {
  for (const forbidden of ['allow-jit', 'allow-unsigned-executable-memory', 'disable-library-validation']) {
    assert.match(signScript, new RegExp(`com\\.apple\\.security\\.cs\\.${forbidden}`));
  }
  assert.match(signScript, /-name node -o -name 'node\.exe' -o -name '\*\.node'/);
  const entitlements = fs.readFileSync(path.join(root, 'src-tauri/entitlements.plist'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(entitlements, /com\.apple\.security\.cs\./, 'the app needs no hardened-runtime exceptions');
  assert.doesNotMatch(entitlements, /app-sandbox/);
});

test('release smoke tests check the exact universal app inside the DMG', () => {
  assert.match(smokeScript, /hdiutil attach "\$DMG" -readonly/);
  assert.match(smokeScript, /codesign --verify --deep --strict/);
  assert.match(smokeScript, /\*arm64\* && "\$archs" == \*x86_64\*/);
  assert.match(smokeScript, /CFBundleShortVersionString/);
  assert.match(smokeScript, /-name node -o -name '\*\.node' -o -name node_modules -o -name 'openwa-supervisor\.js' -o -path '\*\/openwa\/dist'/);
});
