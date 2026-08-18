const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLlmService } = require('../src/server/services/llm-service');

function successfulKeychain() {
  return () => ({
    stdout: {
      on: (event, handler) => {
        if (event === 'data') handler('saved-key');
      },
    },
    stderr: { on: () => {} },
    stdin: { end: () => {} },
    on: (event, handler) => {
      if (event === 'close') handler(0);
    },
  });
}

function withService(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-openai-'));
  try {
    return run(createLlmService({ root, fs, spawn: successfulKeychain() }));
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
