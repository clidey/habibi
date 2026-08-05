const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailService } = require('../src/server/services/mail-service');

// The `security` binary is never invoked in these tests: getSecret always goes
// through a fake spawn, so no real Keychain read or write happens.
const withService = async (accountSecret, run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-mail-'));
  const spawn = (program, args) => ({
    stdout:{ on:(event, handler) => { if (event === 'data' && accountSecret) handler(accountSecret); } },
    stderr:{ on:() => {} },
    stdin:{ end:() => {} },
    on:(event, handler) => { if (event === 'close') handler(accountSecret ? 0 : 1); },
  });
  const service = createMailService({ root, fs, spawn });
  // The callback is async, so this must be awaited: the previous version let
  // `finally` delete `root` while `run` was still reading the config file.
  try { return await run(service, root); }
  finally { fs.rmSync(root, { recursive:true, force:true }); }
};

const withAccount = (service, root, provider, email) => {
  fs.mkdirSync(path.join(root, '.habibi'), { recursive:true });
  const id = `${provider}:${email}`;
  fs.writeFileSync(path.join(root, '.habibi', 'mail-providers.json'), JSON.stringify({
    accounts:{ [id]:{ provider, imap:{ email, host:'imap.example.test', port:993 }, createdAt:new Date().toISOString() } },
  }));
  return id;
};

test('sending requires a connected account, a valid recipient, and a body', async () => {
  await withService(null, async (service, root) => {
    const id = withAccount(service, root, 'gmail', 'me@example.test');

    const noAccount = await service.send({ provider:'unknown-account', to:'a@example.test', subject:'hi', body:'hello' });
    assert.equal(noAccount.ok, false);

    const noSecret = await service.send({ provider:id, to:'a@example.test', subject:'hi', body:'hello' });
    assert.equal(noSecret.ok, false);
    assert.match(noSecret.error, /IMAP first/);
  });
});

test('an invalid recipient or an empty body is rejected before any network call', async () => {
  await withService('app-password', async (service, root) => {
    const id = withAccount(service, root, 'gmail', 'me@example.test');

    const badAddress = await service.send({ provider:id, to:'not-an-email', subject:'hi', body:'hello' });
    assert.equal(badAddress.ok, false);
    assert.match(badAddress.error, /valid recipient/);

    const emptyBody = await service.send({ provider:id, to:'a@example.test', subject:'hi', body:'   ' });
    assert.equal(emptyBody.ok, false);
    assert.match(emptyBody.error, /Write a message/);
  });
});
