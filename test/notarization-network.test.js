const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..', '..');
const script = path.join(root, 'native/notarization-network.sh');

function fixture(run, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-notarization-network-'));
  const bin = path.join(directory, 'bin');
  const log = path.join(directory, 'commands.jsonl');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pfctl'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.includes('-f') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.PF_LOG, JSON.stringify({ args, input }) + '\\n');
if (args.includes('-sr')) console.log(process.env.MISSING_ANCHOR ? 'pass out all' : 'anchor "com.apple/*" all');
if (args.includes('-E')) {
  if (process.env.FAIL_ENABLE) process.exit(1);
  console.log('pf enabled\\nToken : 123456');
}
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_TEMP: directory, PF_LOG: log, ...overrides };
  const invoke = mode => spawnSync('/bin/zsh', [script, mode], { env, encoding: 'utf8' });
  const commands = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  try { run({ invoke, commands, directory }); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('notarization network workaround uses an isolated anchor and releases only its own PF reference', () => {
  fixture(({ invoke, commands, directory }) => {
    assert.equal(invoke('enable').status, 0);
    assert.equal(invoke('enable').status, 0, 'enabling twice must not leak an extra PF reference');
    assert.equal(fs.readFileSync(path.join(directory, 'habibi-notarization-pf-token'), 'utf8').trim(), '123456');
    const rule = commands().find(call => call.args.includes('-f'));
    assert.deepEqual(rule.args, ['-a', 'com.apple/habibi-notarization', '-f', '-']);
    assert.equal(rule.input.trim(), 'block return out quick proto udp from any to any port 443');
    assert.equal(commands().filter(call => call.args.includes('-E')).length, 1);
    assert.equal(invoke('disable').status, 0);
    assert.equal(invoke('disable').status, 0);
    assert.ok(commands().some(call => JSON.stringify(call.args) === JSON.stringify(['-a', 'com.apple/habibi-notarization', '-F', 'rules'])));
    assert.ok(commands().some(call => JSON.stringify(call.args) === JSON.stringify(['-X', '123456'])));
    assert.equal(fs.existsSync(path.join(directory, 'habibi-notarization-pf-token')), false);
    assert.ok(commands().every(call => !call.args.includes('-d')), 'never globally disable PF');
    assert.ok(commands().every(call => !call.args.includes('-f') || call.args.includes('-a')), 'never replace the existing firewall rules');
  });
});

test('notarization network workaround never changes local or self-hosted machines', () => {
  for (const overrides of [{ GITHUB_ACTIONS: '' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { RUNNER_OS: 'Linux' }]) {
    fixture(({ invoke, commands }) => {
      assert.equal(invoke('enable').status, 0);
      assert.equal(invoke('disable').status, 0);
      assert.deepEqual(commands(), []);
    }, overrides);
  }
});

test('missing system anchors fail without overwriting the runner firewall', () => {
  fixture(({ invoke, commands }) => {
    const result = invoke('enable');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to replace existing firewall rules/);
    assert.deepEqual(commands().map(call => call.args), [['-sr']]);
  }, { MISSING_ANCHOR: '1' });
});

test('a failed PF enable removes the temporary anchor and fails the signing preparation', () => {
  fixture(({ invoke, commands }) => {
    assert.notEqual(invoke('enable').status, 0);
    assert.deepEqual(commands().at(-1).args, ['-a', 'com.apple/habibi-notarization', '-F', 'rules']);
  }, { FAIL_ENABLE: '1' });
});

test('both release signing jobs set up and always clean up the notarization network workaround', () => {
  const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const jobs = [release.split('  build-sign-whatsapp:')[1].split('  build-sign-app:')[0], release.split('  build-sign-app:')[1].split('  publish-release:')[0]];
  for (const job of jobs) {
    assert.match(job, /Configure notarization network\s+run: \.\/native\/notarization-network\.sh enable/);
    assert.match(job, /Restore notarization network\s+if: always\(\)\s+run: \.\/native\/notarization-network\.sh disable/);
    assert.ok(job.indexOf('notarization-network.sh enable') < job.indexOf('secrets.APPLE_APP_PASSWORD'));
  }
  const signing = fs.readFileSync(path.join(root, 'native/sign-app.sh'), 'utf8');
  assert.match(signing, /stapler validate "\$DMG"/);
  const component = fs.readFileSync(path.join(root, 'native/package-whatsapp-component.sh'), 'utf8');
  assert.match(component, /stapler validate "\$COMPONENT"/);
  assert.match(component, /spctl -a -t exec/);
});
