const test = require('node:test');
const assert = require('node:assert/strict');
const { browserUrl, browserCommand } = require('../src/client/shared/browser-url');

test('explicit website commands normalize domains without misrouting files or prose', () => {
  for (const command of ['open clidey.com', 'visit clidey.com', 'go to clidey.com', 'clidey.com', 'https://clidey.com'])
    assert.equal(browserCommand(command), 'https://clidey.com/');
  assert.equal(browserCommand('open clidey.com/docs?q=hello%20world#intro'), 'https://clidey.com/docs?q=hello%20world#intro');
  assert.equal(browserCommand('open http://localhost:3000'), 'http://localhost:3000/');
  for (const command of ['project.md', 'open report.pdf', 'open ./clidey.com', 'explain clidey.com', 'open javascript:alert(1)', 'file:///tmp/test', 'open https://user:password@clidey.com', 'open https://clidey.com\nhttps://other.test', 'open https://clidey.com\\evil'])
    assert.equal(browserCommand(command), null, command);
  for (const url of ['clidey.com', 'javascript:alert(1)', 'file:///tmp/test', 'https://user:password@clidey.com', null, {}, 'https://example.test/' + 'a'.repeat(4096)])
    assert.equal(browserUrl(url), null);
});

test('model-routed website actions cannot invent or change a user-supplied destination', () => {
  const { requestedBrowserUrl } = require('../src/client/shared/browser-url');
  assert.equal(requestedBrowserUrl('Please open clidey.com for me', 'https://clidey.com/'), 'https://clidey.com/');
  assert.equal(requestedBrowserUrl('Visit https://clidey.com/docs?q=help please', 'https://clidey.com/docs?q=help'), 'https://clidey.com/docs?q=help');
  assert.equal(requestedBrowserUrl('Open clidey.com.', 'https://clidey.com/'), 'https://clidey.com/');
  for (const url of ['https://attacker.example/', 'https://clidey.com/other', 'javascript:alert(1)', 'https://clidey.com/?leak=secret'])
    assert.equal(requestedBrowserUrl('Open clidey.com', url), null);
});
