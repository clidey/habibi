const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..', '..');

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? javascriptFiles(target)
      : entry.name.endsWith('.js')
        ? [target]
        : [];
  });
}

test('authored client modules stay focused at 250 lines or fewer', () => {
  const files = [path.join(root, 'app.js'), ...javascriptFiles(path.join(root, 'src/client'))];
  const oversized = files.flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);
    return lines > 250 ? [`${path.relative(root, file)} (${lines} lines)`] : [];
  });
  assert.deepEqual(oversized, [], `Split oversized client modules:\n${oversized.join('\n')}`);
});
