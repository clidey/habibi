const test = require('node:test');
const assert = require('node:assert/strict');
const { isTrustedLocalRequest } = require('../src/core/http-security');

const request = (host, origin) => ({ headers:{ host, ...(origin === undefined ? {} : { origin }) } });

test('the local service rejects DNS-rebinding and cross-origin requests', () => {
  assert.equal(isTrustedLocalRequest(request('127.0.0.1:4173')), true);
  assert.equal(isTrustedLocalRequest(request('localhost:4173', 'http://localhost:4173')), true);
  assert.equal(isTrustedLocalRequest(request('habibi.local:4173')), false);
  assert.equal(isTrustedLocalRequest(request('127.0.0.1:4173', 'https://attacker.example')), false);
});
