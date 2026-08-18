const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('command arrows fall back to the shared keyboard loop on every non-result surface', () => {
  const controller = fs.readFileSync(
    path.join(process.cwd(), 'src/client/core/keyboard-controller.js'),
    'utf8',
  );
  assert.match(controller, /if \(!items\.length\) return navigateKeyboard\(direction\)/);
  assert.match(controller, /#results-view:not\(\.hidden\) button:not\(\[disabled\]\)/);
});

test('entering a result list from the command input starts at the first row', () => {
  const controller = fs.readFileSync(
    path.join(process.cwd(), 'src/client/core/keyboard-controller.js'),
    'utf8',
  );
  assert.match(
    controller,
    /focused \? items\.indexOf\(focused\) : (?:\()?enterFromInput \? -1 : selectedIndex/,
  );
});
