const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLlmService } = require('../src/server/services/llm-service');
const { createMailService } = require('../src/server/services/mail-service');

// Process arguments are readable by any local process via `ps` for the lifetime
// of a call, and Habibi's own /api/agents endpoint demonstrates that read. So a
// secret must reach `security` over stdin, never as `-w <value>`.
const recordingSpawn = calls => (program, args) => {
  calls.push([program, ...args]);
  let stdin = '';
  return {
    // `security add-generic-password -w` prompts, so the caller writes the value
    // twice; accept it and report success.
    stdin:{ end: chunk => { stdin += chunk; } },
    stdout:{ on: (event, handler) => { if (event === 'data') handler(''); } },
    stderr:{ on: () => {} },
    on: (event, handler) => { if (event === 'close') handler(0); },
    get written() { return stdin; },
  };
};

const withTempRoot = run => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-keychain-'));
  try { return run(root); }
  finally { fs.rmSync(root, { recursive:true, force:true }); }
};

test('an API key never reaches the process argument list', async () => {
  await withTempRoot(async root => {
    const calls = [];
    const service = createLlmService({ root, fs, spawn:recordingSpawn(calls) });
    const secret = 'sk-super-secret-value';
    await service.configure({ provider:'openai', apiKey:secret });

    const save = calls.find(call => call.includes('add-generic-password'));
    assert.ok(save, 'the key should be written to the keychain');
    assert.equal(save.includes(secret), false, 'the secret must not appear in argv');
    // `-w` must be the final argument, which is what makes `security` prompt.
    assert.equal(save.at(-1), '-w');
    for (const call of calls) assert.equal(call.includes(secret), false);
  });
});

test('IMAP passwords and OAuth refresh tokens never reach the argument list', async () => {
  await withTempRoot(async root => {
    const calls = [];
    const spawn = recordingSpawn(calls);
    const service = createMailService({ root, fs, spawn });

    // configureImap reaches IMAP before saving, so drive saveSecret through the
    // OAuth callback path instead, which only touches the keychain.
    fs.mkdirSync(path.join(root, '.habibi'), { recursive:true });
    fs.writeFileSync(path.join(root, '.habibi', 'mail-providers.json'), JSON.stringify({
      gmail:{ clientId:'id', clientSecret:'shh', redirectUri:'http://127.0.0.1:4173/api/mail/oauth/callback' },
    }));

    const token = 'refresh-token-super-secret';
    const authorized = service.authorize('gmail');
    assert.equal(authorized.ok, true);
    const state = new URL(authorized.url).searchParams.get('state');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok:true, json:async () => ({ refresh_token:token }) });
    try { await service.callback({ code:'code', state }); }
    finally { globalThis.fetch = originalFetch; }

    const save = calls.find(call => call.includes('add-generic-password'));
    assert.ok(save, 'the refresh token should be written to the keychain');
    assert.equal(save.includes(token), false, 'the token must not appear in argv');
    assert.equal(save.at(-1), '-w');
  });
});
