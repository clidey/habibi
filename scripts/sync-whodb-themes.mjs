import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] || path.join(root, '../whodb/ee/sandbox/themes/css'));
const themes = ['deep-ocean', 'midnight-noir', 'aurora-glass', 'forest-moss', 'solar-gold', 'velvet-rose'];
const files = await Promise.all(themes.map((name) => fs.readFile(path.join(source, `${name}.css`), 'utf8')));
// These are CSS design tokens, not a runtime dependency on the sibling checkout.
await fs.writeFile(path.join(root, 'assets/styles/whodb-themes.css'), '/* Theme token snapshots from WhoDB EE sandbox/themes/css.\n * Synced by scripts/sync-whodb-themes.mjs; Habibi-specific geometry lives in app.css. */\n' + files.map((css) => '\n' + css).join(''));
console.log(`Synced ${themes.length} WhoDB sandbox palettes.`);
