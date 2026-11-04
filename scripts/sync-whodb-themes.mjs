import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ux = path.resolve(process.argv[2] || path.join(root, '../ux'));
const source = await fs.readFile(path.join(ux, 'src/themes/index.ts'), 'utf8');
const definitions = [...source.matchAll(/id: "([^"]+)",\s*name: "([^"]+)",\s*description:\s*"([^"]+)"/g)];
if (definitions.length !== 30) throw new Error(`Expected 30 UX palettes, found ${definitions.length}`);
const catalog = definitions.map(match => {
  const [,id,name] = match;
  const personality = source.slice(match.index + match[0].length).match(/personality: "([^"]+)"/)?.[1];
  if (!personality) throw new Error(`Missing personality for ${id}`);
  return {id, name, description: personality};
}).filter(theme => theme.id !== 'deep-ocean');
catalog.sort((a,b) => (a.id === 'paper-ink' ? -1 : b.id === 'paper-ink' ? 1 : 0));
catalog.push({
  id: 'boring-good',
  name: 'Boring (Compliment)',
  description: 'Clean neutral, zero fuss',
});
const css = await fs.readFile(path.join(ux, 'themes/palettes.css'), 'utf8');
await fs.writeFile(path.join(root, 'assets/styles/whodb-themes.css'), css);
await fs.writeFile(path.join(root, 'src/client/features/settings/theme-catalog.js'), `// Synced from @clidey/ux by scripts/sync-whodb-themes.mjs.\nexport const themeCatalog = ${JSON.stringify(catalog,null,2)};\n`);
console.log(`Synced ${catalog.length - 1} selectable UX palettes plus Habibi's local palette.`);
