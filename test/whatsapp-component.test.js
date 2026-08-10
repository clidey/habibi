const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..', '..');
const swift = fs.readFileSync(path.join(root, 'native/HabibiApp.swift'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const packaging = fs.readFileSync(path.join(root, 'native/package-whatsapp-component.sh'), 'utf8');
const signing = fs.readFileSync(path.join(root, 'native/sign-app.sh'), 'utf8');
const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');

test('the release app downloads WhatsApp only after the native UI requests it', () => {
  assert.doesNotMatch(
    swift.match(/func applicationDidFinishLaunching[\s\S]*?\n  }/)?.[0] || '',
    /ensureOpenwaService|prepareWhatsAppComponent/
  );
  assert.match(swift, /if type == "whatsappComponent" \{ prepareWhatsAppComponent\(\); return \}/);
  assert.match(app, /bridge\.postMessage\(\{ type:'whatsappComponent' \}\)/);
});

test('downloaded components are versioned, fixed-origin, and verified against the app signing team', () => {
  assert.match(swift, /Habibi\/components\/whatsapp/);
  assert.match(swift, /https:\/\/github\.com\/clidey\/habibi\/releases\/download\/v/);
  assert.match(swift, /codesign".*"--verify", "--deep", "--strict"/);
  assert.match(swift, /signatureValue\("TeamIdentifier", at: component\) == appTeam/);
  assert.match(swift, /spctl".*"-a", "-t", "exec"/);
  assert.match(swift, /fileSize <= 1_073_741_824/);
  assert.match(swift, /zipinfo".*"-1"/);
});

test('release workflow publishes one app DMG and two separately notarized component ZIPs', () => {
  assert.match(signing, /HABIBI_SIGN_ONLY/);
  assert.match(packaging, /notarytool submit/);
  assert.match(packaging, /stapler staple "\$COMPONENT"/);
  assert.match(release, /HABIBI_SIGN_ONLY=1 \.\/native\/sign-app\.sh/);
  assert.match(release, /\.\/native\/package-whatsapp-component\.sh/);
  assert.match(release, /name: habibi-whatsapp-\$\{\{ matrix\.arch \}\}/);
  assert.match(release, /build\/\*\.dmg \\\n\s*build\/\*\.zip/);
});
