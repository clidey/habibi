const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSkillImportService } = require('../src/agent/skill-import-service');

// The launcher opens Terminal through AppleScript. Untrusted values must reach
// osascript as `argv`, never as script source: a `"` in a prompt or project
// path used to close the AppleScript string literal and allow `do shell script`.
test('launching an imported skill passes hostile input as data, never as AppleScript source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-launch-'));
  fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'commands', 'ship.md'), '# Ship\nPrepare a release.');

  const spawns = [];
  const service = createSkillImportService({
    root,
    stateRoot: root,
    home: path.join(root, 'home'),
    spawn: (program, args) => {
      spawns.push({ program, args });
      return { unref() {} };
    },
  });
  const skill = service.list().find((item) => item.kind === 'command');
  const payload = 'hi" & (do shell script "echo INJECTED") & "';
  const result = await service.execute({ id: skill.id, toolInput: payload });
  assert.equal(result.ok, true);
  assert.equal(spawns.length, 1);

  const [{ program, args }] = spawns;
  assert.equal(program, 'osascript');
  // The script is the only `-e` value; the payload must not appear inside it.
  const script = args[args.indexOf('-e') + 1];
  assert.equal(script.includes(payload), false);
  assert.equal(script.includes('INJECTED'), false);
  assert.match(script, /^on run argv/);
  // The prompt travels by file so it stays out of the argument list, which any
  // local process can read with `ps`.
  const promptFile = args.find(
    (value) => typeof value === 'string' && value.endsWith('prompt.txt'),
  );
  assert.ok(promptFile, 'the prompt should be passed as a file path');
  assert.equal(
    args.some((value) => String(value).includes('do shell script')),
    false,
  );
  assert.equal(fs.readFileSync(promptFile, 'utf8').includes(payload), true);
  assert.equal(fs.statSync(promptFile).mode & 0o777, 0o600);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
});
