const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// The component download, verification and supervision now live in Rust
// (crates/habibi-integrations/src/whatsapp) with their own tests. These cover
// the client side of that contract.
const root = path.join(__dirname, '..', '..');
function readJavaScriptTree(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? readJavaScriptTree(target)
      : entry.name.endsWith('.js')
        ? [fs.readFileSync(target, 'utf8')]
        : [];
  });
}
const app = [
  fs.readFileSync(path.join(root, 'app.js'), 'utf8'),
  ...readJavaScriptTree(path.join(root, 'src/client')),
].join('\n');

test('the UI requests the WhatsApp component only through the native bridge', () => {
  assert.match(app, /bridge\.postMessage\(\{\s*type:\s*'whatsappComponent',?\s*\}\)/);
});

test('native download progress is forwarded to the WhatsApp setup UI', () => {
  assert.match(app, /<progress id="whatsapp-component-progress" max="100" value="0"/);
  assert.match(app, /mountUxProgress\(resultsView\.querySelector\('#whatsapp-progress-host'\)\)/);
  assert.match(app, /updateUxProgress\(progress, status\.progress, true\)/);
  assert.doesNotMatch(app, /Downloading WhatsApp support securely… \$\{status\.progress\}%/);
});
