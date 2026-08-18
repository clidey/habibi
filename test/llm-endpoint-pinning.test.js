const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLlmService, PROVIDERS } = require('../src/server/services/llm-service');

// Requests to a hosted provider carry an API key read from the macOS Keychain.
// If a caller could choose the endpoint, one /api/llm/configure call would
// redirect that key — and the whole conversation — to a host of its choosing.
const withService = (run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-llm-'));
  const keychain = [];
  const spawn = () => {
    const child = {
      stdout: {
        on: (event, handler) => {
          if (event === 'data') handler('stored-api-key');
        },
      },
      stderr: { on: () => {} },
      stdin: { end: () => {} },
      on: (event, handler) => {
        if (event === 'close') handler(0);
      },
    };
    keychain.push(child);
    return child;
  };
  try {
    return run({ service: createLlmService({ root, fs, spawn }), root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test('a hosted provider endpoint cannot be redirected by the caller', async () => {
  await withService(async ({ service, root }) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    let result;
    try {
      result = await service.configure({
        provider: 'openai',
        endpoint: 'http://attacker.example/v1',
        apiKey: 'sk-test',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(result.ok, true);
    assert.equal(result.endpoint, PROVIDERS.openai.endpoint);

    // The rejected endpoint must not reach disk either, or a later read would
    // pick it up.
    const stored = JSON.parse(
      fs.readFileSync(path.join(root, '.habibi', 'llm-config.json'), 'utf8'),
    );
    assert.equal(stored.endpoint, PROVIDERS.openai.endpoint);
    assert.equal(String(stored.endpoint).includes('attacker.example'), false);
  });
});

test('a config file poisoned before the guard existed is re-pinned on read', async () => {
  await withService(async ({ service, root }) => {
    fs.mkdirSync(path.join(root, '.habibi'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.habibi', 'llm-config.json'),
      JSON.stringify({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        endpoint: 'https://attacker.example',
      }),
    );
    const state = await service.configured();
    assert.equal(state.endpoint, PROVIDERS.anthropic.endpoint);
  });
});

test('a local provider may move, but only to loopback', async () => {
  await withService(async ({ service }) => {
    const moved = await service.configure({
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11500',
    });
    assert.equal(moved.endpoint, 'http://127.0.0.1:11500');

    const named = await service.configure({
      provider: 'ollama',
      endpoint: 'http://localhost:11434',
    });
    assert.equal(named.endpoint, 'http://localhost:11434');

    // Anything that leaves the machine falls back to the pinned default.
    for (const endpoint of [
      'http://evil.tld:11434',
      'https://attacker.example',
      'http://169.254.169.254',
      'file:///etc/passwd',
      'not-a-url',
    ]) {
      const rejected = await service.configure({ provider: 'ollama', endpoint });
      assert.equal(
        rejected.endpoint,
        PROVIDERS.ollama.endpoint,
        `${endpoint} should not be accepted`,
      );
    }
  });
});
