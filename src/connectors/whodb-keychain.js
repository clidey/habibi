const { spawn } = require('node:child_process');
const path = require('node:path');

/** Store WhoDB credentials in Keychain; secret values never enter process arguments. */
function createWhoDbKeychain({ spawnProcess = spawn, helperPath = process.env.HABIBI_KEYCHAIN_HELPER || path.join(process.env.HABIBI_ROOT || process.cwd(), 'build/Habibi.app/Contents/MacOS/HabibiKeychain') } = {}) {
  function command(args, input) {
    return new Promise((resolve, reject) => {
      const child = spawnProcess(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      const timer = setTimeout(() => child.kill(), 15_000);
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error('WhoDB credentials are unavailable in macOS Keychain.'));
        resolve(output.trim());
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input || '');
    });
  }
  return {
    async get(host) {
      try {
        const saved = JSON.parse(await command(['get', host]));
        return typeof saved.accessToken === 'string' && saved.accessToken && Number.isFinite(saved.expiresAt) ? saved : null;
      }
      catch { return null; }
    },
    async set(host, value) {
      const secret = JSON.stringify(value);
      await command(['set', host], secret);
      if (await command(['get', host]) !== secret) throw new Error('WhoDB credentials could not be verified in macOS Keychain.');
    },
  };
}
module.exports = { createWhoDbKeychain };
