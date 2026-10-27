const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLlmService } = require('../src/server/services/llm-service');

const { providerKeychain } = require('./helpers/provider-keychain');

async function withService(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-openai-'));
  try {
    return await run(createLlmService({ root, fs, spawn: providerKeychain() }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('OpenAI setup verifies a supplied key before saving it', async () => {
  await withService(async (service) => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    };
    try {
      const result = await service.configure({
        provider: 'openai',
        model: ' chat-latest ',
        apiKey: ' sk-test ',
      });
      assert.equal(result.ok, true);
      assert.equal(result.model, 'chat-latest');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, 'https://api.openai.com/v1/models/chat-latest');
      assert.equal(requests[0].options.headers.Authorization, 'Bearer sk-test');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('OpenAI setup explains rejected keys without saving configuration', async () => {
  await withService(async (service) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    try {
      const result = await service.configure({ provider: 'openai', apiKey: 'sk-invalid' });
      assert.equal(result.ok, false);
      assert.match(result.error, /rejected that API key/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('long provider keys survive storage and a fresh service reads the entire credential', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-long-key-'));
  const calls = [];
  const spawn = providerKeychain(calls);
  const apiKey = 'sk-project-dummy-' + 'long-key-fixture-'.repeat(30);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    const saved = await createLlmService({ root, fs, spawn }).configure({ provider: 'openai', model: 'test-model', apiKey });
    assert.equal(saved.ok, true);
    const restarted = await createLlmService({ root, fs, spawn }).configured();
    assert.equal(restarted.configured, true);
    assert.equal(restarted.model, 'test-model');
    assert.equal(calls.some(call => call.includes('set-model-key')), true);
    assert.equal(calls.some(call => call.includes('add-generic-password')), false);
    assert.equal(calls.some(call => call.some(arg => String(arg).includes(apiKey))), false);
    assert.equal(fs.readFileSync(path.join(root, '.habibi/llm-config.json'), 'utf8').includes(apiKey), false);
  } finally { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); }
});

test('a successful save with truncated read-back is rejected before configuration is published', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-truncated-key-'));
  const spawn = providerKeychain([], 'x'.repeat(128));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    const broken = (program, args, options) => program === 'security' ? spawn(program, args, options) : {
      stdout: { on() {} }, stderr: { on() {} }, stdin: { end() {} },
      on(event, callback) { if (event === 'close') callback(0); },
    };
    const result = await createLlmService({ root, fs, spawn: broken }).configure({ provider: 'openai', apiKey: 'dummy-long-key-'.repeat(30) });
    assert.equal(result.ok, false);
    assert.match(result.error, /complete API key.*saved and verified/);
    assert.equal(fs.existsSync(path.join(root, '.habibi/llm-config.json')), false);
  } finally { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); }
});
