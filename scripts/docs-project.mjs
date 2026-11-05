import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const docs = path.join(repository, 'docs');
const requireDocs = createRequire(path.join(docs, 'package.json'));
export const doryPackage = requireDocs.resolve('@clidey/dory/package.json');
export const doryRoot = path.dirname(doryPackage);
export const requireDory = createRequire(doryPackage);
export const excluded = new Set([
  'node_modules',
  'dist',
  'dist-ssr',
  '.git',
  '.vite',
  '.vite-temp',
  'package.json',
]);

export async function pages(directory = docs) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const found = await Promise.all(
    entries
      .filter((entry) => !excluded.has(entry.name) && !entry.name.startsWith('.'))
      .map(async (entry) => {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink())
          throw new Error(`Documentation must not contain symbolic links: ${file}`);
        return entry.isDirectory() ? pages(file) : entry.name.endsWith('.mdx') ? [file] : [];
      }),
  );
  return found.flat().sort();
}
