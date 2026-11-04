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
      : /\.jsx?$/.test(entry.name)
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

test('client features depend on shared modules instead of importing sibling features', () => {
  const features = path.join(root, 'src/client/features');
  const violations = javascriptFiles(features).flatMap((file) => {
    const owner = path.relative(features, file).split(path.sep)[0];
    const source = fs.readFileSync(file, 'utf8');
    return [...source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)].flatMap(
      (match) => {
        const imported = path.resolve(path.dirname(file), match[1]);
        if (!imported.startsWith(`${features}${path.sep}`)) return [];
        const target = path.relative(features, imported).split(path.sep)[0];
        return owner === target
          ? []
          : [`${path.relative(root, file)} -> ${path.relative(root, imported)}`];
      },
    );
  });
  assert.deepEqual(
    violations,
    [],
    `Move shared behavior to core/, data/, or ui/:\n${violations.join('\n')}`,
  );
});
