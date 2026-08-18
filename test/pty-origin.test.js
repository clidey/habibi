const test = require('node:test');
const assert = require('node:assert/strict');
const { isBrowserOrigin, isTrustedLocalRequest } = require('../src/core/http-security');

const request = (host, origin) => ({
  headers: { host, ...(origin === undefined ? {} : { origin }) },
});

// The terminal WebSocket hands out a login shell, so it is held to a stricter
// standard than the read-only HTTP routes: those tolerate a missing Origin for
// non-browser local callers, but every browser sends one on a WebSocket
// handshake, so requiring it stops another local process claiming a shell.
test('the terminal handshake requires proof the caller is the launcher page', () => {
  assert.equal(isBrowserOrigin(request('127.0.0.1:4173', 'http://127.0.0.1:4173')), true);
  assert.equal(isBrowserOrigin(request('localhost:4173', 'http://localhost:4173')), true);

  assert.equal(
    isBrowserOrigin(request('127.0.0.1:4173')),
    false,
    'an absent Origin must not reach the terminal',
  );
  assert.equal(isBrowserOrigin(request('127.0.0.1:4173', '')), false);
  assert.equal(isBrowserOrigin(request('127.0.0.1:4173', 'https://evil.example')), false);
  assert.equal(isBrowserOrigin(request('127.0.0.1:4173', 'http://127.0.0.1:4174')), false);
  assert.equal(isBrowserOrigin(request('127.0.0.1:4173', 'null')), false);
});

test('the HTTP gate stays permissive about a missing Origin', () => {
  // Deliberately different from the terminal: non-browser local callers use it.
  assert.equal(isTrustedLocalRequest(request('127.0.0.1:4173')), true);
  assert.equal(isTrustedLocalRequest(request('127.0.0.1:4173', 'https://evil.example')), false);
  assert.equal(isTrustedLocalRequest(request('evil.example', 'http://127.0.0.1:4173')), false);
});
