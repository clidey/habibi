import { spawnSync } from 'node:child_process';

// esbuild resolves imports but treats any unknown identifier as a global, so a
// missing import bundles cleanly and then throws a ReferenceError in the UI.
// The client is untyped, so full checkJs is noise; these three codes are the
// ones that catch that specific failure.
const undefinedIdentifier = /error (TS2304|TS2552|TS2307):/;

const result = spawnSync('npx', ['tsc', '-p', 'tsconfig.client.json'], { encoding:'utf8' });
const failures = `${result.stdout || ''}${result.stderr || ''}`
  .split('\n')
  .filter(line => undefinedIdentifier.test(line));

if (failures.length) {
  console.error(`Undefined identifiers or unresolved imports in client code:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('Client references resolve.');
