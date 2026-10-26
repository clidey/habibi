const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { createWhoDbKeychain } = require('../src/connectors/whodb-keychain');
const { createWhoDbAuth } = require('../src/connectors/whodb-auth');

// Exercise actual macOS Keychain with an isolated dummy entry, then always remove it.
const helperPath = path.resolve(process.argv[2] || 'build/Habibi.app/Contents/MacOS/HabibiKeychain');
const account = `https://habibi-smoke-${randomUUID()}.invalid`;
const store = createWhoDbKeychain({ helperPath });
const tokens = { accessToken: 'dummy-access-'.repeat(4096), refreshToken: 'dummy-refresh-'.repeat(4096), expiresAt: Date.now() + 3600000 };
(async () => {
  try {
    await store.set(account, tokens);
    assert.deepEqual(await store.get(account), tokens);
    for (let restart = 0; restart < 2; restart++) {
      const auth = createWhoDbAuth({ store, fetcher: () => { throw new Error('Unexpected network request'); } });
      assert.equal(await auth.token(account), tokens.accessToken);
    }
    console.log('Native Keychain preserved a session larger than 100 KB across fresh auth instances.');
  } finally {
    execFileSync(helperPath, ['delete', account], { stdio: ['ignore', 'ignore', 'pipe'] });
  }
})().catch(() => { console.error('Native Keychain smoke test failed.'); process.exitCode = 1; });
