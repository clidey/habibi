const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenwaClient } = require('../src/connectors/openwa-client');

// The connector previously let fs.readFileSync's raw ENOENT (with an absolute
// path) reach the HTTP response. It must now report which of the two distinct
// setup problems applies, without leaking a filesystem path.
test('a missing API key is reported plainly, not as a raw ENOENT', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-openwa-'));
  const client = createOpenwaClient({ workspace, baseUrl:'http://127.0.0.1:1' });
  await assert.rejects(
    () => client.request('/api/sessions'),
    error => {
      assert.equal(error.message, 'WhatsApp gateway is not set up. See the README for how to run OpenWA.');
      assert.equal(error.message.includes(workspace), false, 'must not leak the key file path');
      return true;
    },
  );
  fs.rmSync(workspace, { recursive:true, force:true });
});

test('a key that exists but an unreachable gateway is reported as not running', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-openwa-'));
  fs.mkdirSync(path.join(workspace, '.openwa', 'data'), { recursive:true });
  fs.writeFileSync(path.join(workspace, '.openwa', 'data', '.api-key'), 'test-key');
  // Port 1 is a privileged, always-refused port, so no server can be listening.
  const client = createOpenwaClient({ workspace, baseUrl:'http://127.0.0.1:1' });
  await assert.rejects(
    () => client.request('/api/sessions'),
    error => {
      assert.equal(error.message, 'WhatsApp gateway is not running. See the README for how to start OpenWA.');
      return true;
    },
  );
  fs.rmSync(workspace, { recursive:true, force:true });
});
