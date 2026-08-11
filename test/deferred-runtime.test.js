const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const loaded = fragment => Object.keys(require.cache).some(file => file.includes(fragment));
const fakeSpawn = () => ({
  stdout:{ on() {} }, stderr:{ on() {} }, stdin:{ end() {} },
  on(event, handler) { if (event === 'close') handler(1); },
});

test('mail status does not initialize IMAP, MIME, sanitizer, or SMTP libraries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-deferred-mail-'));
  try {
    const { createMailService } = require('../src/server/services/mail-service');
    const service = createMailService({ root, fs, spawn:fakeSpawn });
    await service.status();
    for (const dependency of ['/imapflow/', '/mailparser/', '/sanitize-html/', '/nodemailer/']) {
      assert.equal(loaded(dependency), false, `${dependency} should remain deferred after status`);
    }
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});

test('LLM status does not initialize the Pi provider stack', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-deferred-llm-'));
  try {
    const { createLlmService } = require('../src/server/services/llm-service');
    const service = createLlmService({ root, fs, spawn:fakeSpawn });
    await service.configured();
    assert.equal(loaded('/pi-harness.js'), false);
    assert.equal(loaded('/pi-ai/'), false);
    assert.equal(loaded('/pi-agent-core/'), false);
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});
