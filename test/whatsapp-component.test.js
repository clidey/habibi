const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..', '..');
const swift = fs.readFileSync(path.join(root, 'native/HabibiApp.swift'), 'utf8');
function readJavaScriptTree(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? readJavaScriptTree(target)
      : entry.name.endsWith('.js')
        ? [fs.readFileSync(target, 'utf8')]
        : [];
  });
}
const app = [
  fs.readFileSync(path.join(root, 'app.js'), 'utf8'),
  ...readJavaScriptTree(path.join(root, 'src/client')),
].join('\n');
const packaging = fs.readFileSync(path.join(root, 'native/package-whatsapp-component.sh'), 'utf8');
const signing = fs.readFileSync(path.join(root, 'native/sign-app.sh'), 'utf8');
const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');

test('the release app downloads WhatsApp only after the native UI requests it', () => {
  assert.doesNotMatch(
    swift.match(/func applicationDidFinishLaunching[\s\S]*?\n  }/)?.[0] || '',
    /ensureOpenwaService|prepareWhatsAppComponent/,
  );
  assert.match(swift, /if type == "whatsappComponent" \{ prepareWhatsAppComponent\(\); return \}/);
  assert.match(app, /bridge\.postMessage\(\{\s*type:\s*'whatsappComponent',?\s*\}\)/);
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

test('release workflow publishes two app DMGs and two separately notarized component ZIPs', () => {
  assert.match(signing, /HABIBI_SIGN_ONLY/);
  assert.match(packaging, /notarytool submit/);
  assert.match(packaging, /stapler staple "\$COMPONENT"/);
  assert.match(release, /HABIBI_SIGN_ONLY=1 \.\/native\/sign-app\.sh/);
  assert.match(release, /\.\/native\/package-whatsapp-component\.sh/);
  assert.match(release, /name: habibi-whatsapp-\$\{\{ matrix\.arch \}\}/);
  assert.match(release, /name: habibi-dmg-\$\{\{ matrix\.arch \}\}/);
  assert.match(release, /runner: macos-15-intel/);
  assert.match(release, /smoke-test-release\.sh/);
  assert.match(release, /smoke-test-whatsapp-component\.sh/);
  assert.match(release, /build\/\*\.dmg \\\n\s*build\/\*\.zip/);
});

test('native download progress is forwarded to the WhatsApp setup UI', () => {
  assert.match(swift, /task\.progress\.observe\(\\\.fractionCompleted/);
  assert.match(swift, /sendWhatsAppComponentStatus\("downloading", progress: percentage\)/);
  assert.match(app, /Downloading WhatsApp support securely… \$\{status\.progress\}%/);
});

test('an already-verified WhatsApp component is not re-verified on every "open WhatsApp"', () => {
  // codesign --verify --deep on the Chromium-containing component is real,
  // measurable cost — reported live as "everytime I go to it, it says it's
  // verifying the component" and a slow reconnect. Nothing on disk can change
  // within one running Habibi process, so a second verification within the
  // same run is pure waste; caching the verified path skips it.
  assert.match(swift, /private var verifiedWhatsAppComponentPath: String\?/);
  assert.match(
    swift,
    /if verifiedWhatsAppComponentPath == installed\.path \{\s*\n\s*startWhatsAppComponentAndNotify\(\)\s*\n\s*return\s*\n\s*\}/,
    'prepareWhatsAppComponent must skip verification entirely when this exact path was already verified this run',
  );
  assert.match(
    swift,
    /self\.verifiedWhatsAppComponentPath = installed\.path\s*\n\s*self\.startWhatsAppComponentAndNotify\(\)/,
    'a successful verification must be cached before starting the service',
  );
  assert.match(
    swift,
    /self\.verifiedWhatsAppComponentPath = component\.path\s*\n\s*self\.startWhatsAppComponentAndNotify\(\)/,
    "a fresh install's own verification must also be cached, so the very next launch does not re-verify redundantly",
  );
});
