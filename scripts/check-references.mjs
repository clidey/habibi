import { spawnSync } from 'node:child_process';

// esbuild treats an unknown identifier as a global and CommonJS resolves lazily,
// so a missing import or require builds cleanly and then fails at runtime. The
// code is untyped, so full checkJs is noise; these three codes catch that one
// failure mode in both the browser bundle and the Node service.
const undefinedIdentifier = /error (TS2304|TS2552|TS2307):/;

const result = spawnSync('npx', ['tsc', '-p', 'tsconfig.references.json'], { encoding:'utf8' });
const failures = `${result.stdout || ''}${result.stderr || ''}`
  .split('\n')
  .filter(line => undefinedIdentifier.test(line));

if (failures.length) {
  console.error(`Undefined identifiers or unresolved imports:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('All references resolve.');
