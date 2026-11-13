const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// The release pipeline only runs when a version is published, so its
// load-bearing properties are pinned here instead of discovered mid-release.
const root = path.join(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const release = read('.github/workflows/release.yml');
const config = JSON.parse(read('src-tauri/tauri.conf.json'));
const buildComponent = read('native/build-whatsapp-component.sh');
const packageComponent = read('native/package-whatsapp-component.sh');
const smokeComponent = read('native/smoke-test-whatsapp-component.sh');
const runtime = read('crates/habibi-integrations/src/whatsapp/runtime.rs');
const download = read('crates/habibi-integrations/src/whatsapp/runtime/download.rs');
const archive = read('crates/habibi-integrations/src/whatsapp/runtime/archive.rs');

function job(name) {
  const body = release.split('\njobs:\n')[1];
  const match = body.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:\\n|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `release.yml has a ${name} job`);
  return match[1];
}

test('the release keeps its manual trigger, version inputs and least-privilege token', () => {
  assert.match(release, /on:\n  workflow_dispatch:\n    inputs:\n      version-bump:[\s\S]*options:\n\s+- 'major'[^\n]*\n\s+- 'minor'[^\n]*\n\s+- 'patch'/);
  assert.match(release, /explicit-version:/);
  assert.doesNotMatch(release, /^on:\n\s+push:/m);
  assert.match(release, /^permissions:\n  contents: read\n/m);
  const writers = [...release.matchAll(/contents: write/g)];
  assert.equal(writers.length, 1, 'only one job may write to the repository');
  assert.match(job('publish-release'), /permissions:\n      contents: write/);
});

test('every action is pinned by full commit SHA and every runner that supports it is hardened', () => {
  const uses = [...release.matchAll(/uses: ([^\s]+)/g)].map((match) => match[1]);
  assert.ok(uses.length > 0);
  for (const action of uses) assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, action);
  for (const name of ['calculate-version', 'macos-whatsapp-component', 'app', 'publish-release']) {
    assert.match(job(name), /step-security\/harden-runner@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+egress-policy: block/, name);
  }
  for (const checkout of release.matchAll(/actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n((?:\s{10}[^\n]*\n)+)/g)) {
    assert.match(checkout[1], /persist-credentials: false/);
  }
});

test('the updater feed is the latest release and the release refuses a placeholder key', () => {
  assert.deepEqual(config.plugins.updater.endpoints, ['https://github.com/clidey/habibi/releases/latest/download/latest.json']);
  assert.equal(typeof config.plugins.updater.pubkey, 'string');
  assert.match(job('calculate-version'), /REPLACE_WITH_UPDATER_PUBLIC_KEY/);
  assert.match(job('calculate-version'), /secrets\.TAURI_SIGNING_PRIVATE_KEY != ''/);
  // Local builds work without the key; the release turns signed updater
  // artifacts on.
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.match(job('app'), /createUpdaterArtifacts: true/);
  assert.match(job('app'), /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
  const publish = job('publish-release');
  for (const platform of ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'linux-x86_64']) {
    assert.ok(publish.includes(`"${platform}"`), platform);
  }
  assert.match(publish, /--rawfile signature "build\/\$1\.sig"/);
  assert.match(publish, /build\/latest\.json\n/);
});

test('macOS ships one signed, notarized universal DMG; Windows signs only with its secrets', () => {
  const app = job('app');
  assert.match(app, /platform: macos\n\s+runner: macos-15/);
  assert.match(app, /platform: windows\n\s+runner: windows-/);
  assert.match(app, /platform: linux\n\s+runner: ubuntu-/);
  assert.match(app, /--target universal-apple-darwin --bundles app/);
  assert.match(app, /APPLE_SIGNING_IDENTITY: \$\{\{ secrets\.APPLE_DEVELOPER_ID_APPLICATION \}\}/);
  assert.match(app, /\.\/native\/sign-app\.sh target\/universal-apple-darwin\/release\/bundle\/macos\/Habibi\.app/);
  assert.match(app, /smoke-test-release\.sh/);
  assert.match(app, /--bundles nsis/);
  assert.match(app, /--bundles appimage,deb/);
  assert.match(app, /certificateThumbprint/);
  assert.match(app, /the Windows installer is UNSIGNED/);
  assert.match(job('publish-release'), /windows-unsigned\.txt/);
  assert.equal(config.bundle.macOS.hardenedRuntime, true);
  assert.equal(config.bundle.macOS.entitlements, 'entitlements.plist');
  // Apple secrets reach only macOS steps.
  for (const step of app.split(/\n      - /)) {
    if (/secrets\.APPLE_/.test(step)) assert.match(step, /if: runner\.os == 'macOS'/, step.split('\n')[0]);
  }
});

test('the app bundle carries no Node, supervisor or OpenWA', () => {
  const resources = Object.keys(config.bundle.resources).join('\n');
  assert.doesNotMatch(resources, /openwa|node_modules|native\//);
  assert.equal(config.bundle.externalBin, undefined);
  // Release builds never pick up a Node from PATH or a development tree.
  assert.match(runtime, /let development = cfg!\(debug_assertions\);/);
});

test('WhatsApp components are published per OS and architecture under the names the app downloads', () => {
  const macComponent = job('macos-whatsapp-component');
  assert.match(macComponent, /arch: arm64\n\s+runner: macos-15\n/);
  assert.match(macComponent, /arch: x64\n\s+runner: macos-15-intel\n/);
  assert.match(macComponent, /\.\/native\/build-whatsapp-component\.sh/);
  assert.match(macComponent, /\.\/native\/package-whatsapp-component\.sh/);
  assert.match(macComponent, /smoke-test-whatsapp-component\.sh "build\/Habibi-WhatsApp-\$\{\{ matrix\.arch \}\}-\$VERSION\.zip"/);
  const publish = job('publish-release');
  for (const asset of [
    'Habibi-WhatsApp-arm64-$VERSION.zip',
    'Habibi-WhatsApp-x64-$VERSION.zip',
    'Habibi-WhatsApp-windows-x64-$VERSION.tar.gz',
    'Habibi-WhatsApp-linux-x64-$VERSION.tar.gz',
  ]) {
    assert.ok(publish.includes(`"build/${asset}"`), asset);
  }
  // The runtime builds the same names.
  assert.match(download, /format!\("Habibi-WhatsApp-\{arch\}-\{version\}\.zip"\)/);
  assert.match(download, /format!\("Habibi-WhatsApp-\{os\}-\{arch\}-\{version\}\.tar\.gz"\)/);
  assert.match(download, /https:\/\/github\.com\/clidey\/habibi\/releases\/download\/v\{version\}\//);
  assert.match(buildComponent, /ARCHIVE="\$ROOT\/build\/Habibi-WhatsApp-\$OS-\$ARCH-\$VERSION\.tar\.gz"/);
  assert.match(packageComponent, /ARCHIVE="\$ROOT\/build\/Habibi-WhatsApp-\$ARCH-\$VERSION\.zip"/);
});

test('Windows and Linux apps pin the SHA-256 of the component built and tested in the same job', () => {
  const app = job('app');
  const built = app.indexOf('bash native/build-whatsapp-component.sh');
  const smoked = app.indexOf('bash native/smoke-test-whatsapp-component.sh');
  const pinned = app.indexOf('HABIBI_WHATSAPP_COMPONENT_SHA256=$digest');
  const compiled = app.indexOf('pnpm tauri build --bundles nsis');
  assert.ok(built >= 0 && built < smoked && smoked < pinned && pinned < compiled, 'build, smoke-test, pin, then compile the app');
  assert.match(app, /sha256sum "build\/Habibi-WhatsApp-\$\{\{ matrix\.platform \}\}-x64-\$VERSION\.tar\.gz"/);
  // Never a digest fetched from the release next to the archive.
  assert.doesNotMatch(release, /sha256[^\n]*curl|curl[^\n]*sha256|SHA256SUMS/i);
  assert.match(archive, /option_env!\("HABIBI_WHATSAPP_COMPONENT_SHA256"\)/);
});

test('the component layout matches what the runtime starts', () => {
  assert.match(runtime, /"Habibi WhatsApp Runtime\.app"[^\n]*"whatsapp-runtime"/);
  assert.match(runtime, /contents\.join\("MacOS"\)\.join\("node"\)/);
  assert.match(runtime, /resources\.join\("openwa-supervisor\.js"\)/);
  assert.match(runtime, /if cfg!\(windows\) \{ "node\.exe" \} else \{ "node" \}/);
  assert.match(buildComponent, /COMPONENT="\$OUT\/Habibi WhatsApp Runtime\.app"/);
  assert.match(buildComponent, /NODE_DEST="\$COMPONENT\/Contents\/MacOS\/node"/);
  assert.match(buildComponent, /COMPONENT="\$OUT\/whatsapp-runtime"/);
  assert.match(buildComponent, /NODE_DEST="\$COMPONENT\/node\.exe"/);
  assert.match(buildComponent, /cp "\$ROOT\/native\/openwa-supervisor\.js" "\$RESOURCES\/openwa-supervisor\.js"/);
  // Pinned third-party versions come from versions.sh, and the shipped Node
  // is the one that installed OpenWA's native modules.
  assert.match(buildComponent, /source "\$ROOT\/native\/versions\.sh"/);
  assert.match(buildComponent, /"\$\(node --version\)" == "v\$NODE_VERSION"/);
  assert.match(buildComponent, /SHASUMS256\.txt/);
});

test('the macOS component signs Node and Chromium with the JIT entitlements and is notarized', () => {
  assert.match(packageComponent, /ENTITLEMENTS="\$ROOT\/native\/whatsapp-runtime-entitlements\.plist"/);
  assert.match(packageComponent, /sign_with_entitlements "\$COMPONENT\/Contents\/MacOS\/node"/);
  assert.match(packageComponent, /notarytool submit "\$SUBMISSION"/);
  assert.match(packageComponent, /stapler staple "\$COMPONENT"/);
  assert.match(packageComponent, /TeamIdentifier=\$APPLE_TEAM_ID/);
  const entitlements = read('native/whatsapp-runtime-entitlements.plist').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.doesNotMatch(entitlements, /allow-dyld-environment-variables|automation|personal-information/);
  // The smoke test runs the signed Node, not merely inspects it.
  assert.match(smokeComponent, /"\$NODE" -e/);
  assert.match(smokeComponent, /requires its live Habibi parent/);
});
