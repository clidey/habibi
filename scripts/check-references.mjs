import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

// esbuild treats an unknown identifier as a global and CommonJS resolves lazily,
// so a missing import or require builds cleanly and then fails at runtime. The
// code is untyped, so full checkJs is noise; these codes catch unresolved
// references and missing exports in both the browser bundle and Node service.
const unresolvedReference = /error (TS1192|TS2304|TS2305|TS2307|TS2552|TS2614|TS2724):/;

const require = createRequire(import.meta.url);
const compiler = path.resolve(
  path.dirname(require.resolve('typescript/package.json')),
  require('typescript/package.json').bin.tsc,
);
const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.references.json'], {
  encoding: 'utf8',
});
if (result.error || result.signal || result.status === null) {
  console.error('Reference checking could not run:', result.error || result.signal);
  process.exit(1);
}
const failures = `${result.stdout || ''}${result.stderr || ''}`
  .split('\n')
  .filter((line) => unresolvedReference.test(line));

if (failures.length) {
  console.error(`Undefined identifiers or unresolved imports:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('All references resolve.');
