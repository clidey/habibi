import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] || path.join(root, '../whodb/ee/frontend/src/assets/whodb-icons'));
// Feature names map to WhoDB glyphs, plus the local WhatsApp brand outline.
const aliases = {
  activity: 'chart', house: 'home', database: 'source', 'message-circle': 'chat',
  'arrow-left': 'arrow-right', 'arrow-right': 'arrow-right', 'arrow-up-right': 'external',
  bot: 'ai', boxes: 'packages', braces: 'code', 'calendar-check': 'calendar',
  'calendar-clock': 'calendar', 'calendar-days': 'calendar', 'chart-no-axes-combined': 'chart',
  check: 'check', 'chevron-down': 'chevron-down', 'chevron-right': 'chevron-right',
  'chevrons-up-down': 'up-down', 'circle-stop': 'x-circle', copy: 'copy', download: 'download',
  file: 'file', files: 'file', 'file-text': 'file-text', folder: 'folder', 'folder-open': 'folder',
  forward: 'redo', image: 'camera', inbox: 'mail', keyboard: 'input', lightbulb: 'ai',
  'lock-keyhole': 'lock', mail: 'mail', 'message-circle-more': 'whatsapp', whatsapp: 'whatsapp', mic: 'mobile',
  monitor: 'monitor', moon: 'moon', 'octagon-x': 'x-circle', 'panel-top': 'app',
  'panel-top-close': 'app', paperclip: 'paperclip', pause: 'columns', 'plug-zap': 'provider',
  power: 'signout', radio: 'play', 'refresh-cw': 'refresh', rocket: 'promote',
  'rotate-cw': 'refresh', route: 'lineage', 'scan-search': 'scan', 'scroll-text': 'file-text',
  search: 'search', settings: 'settings', 'settings-2': 'sliders', 'sliders-horizontal': 'sliders',
  'shield-check': 'shield', 'ship-wheel': 'container', sparkles: 'ai', sun: 'sun',
  'sun-moon': 'sun', 'square-terminal': 'terminal', 'terminal-square': 'terminal', 'trash-2': 'trash', video: 'camera', x: 'close',
};
const icons = {};
for (const name of [...new Set(Object.values(aliases))].sort()) {
  const file = name === 'whatsapp' ? path.join(root, 'assets/icons/whatsapp.svg') : path.join(source, `${name}.svg`);
  const svg = (await fs.readFile(file, 'utf8')).trim();
  if (!/^<svg\b/.test(svg) || /<(?:script|foreignObject|use|image)\b|\bon\w+\s*=|\bhref\s*=/i.test(svg)) throw new Error(`Unsafe WhoDB glyph: ${name}`);
  icons[name] = svg.replace(/>\s+</g, '><');
}
await fs.writeFile(path.join(root, 'assets/whodb-icons.json'), JSON.stringify({ aliases, icons }, null, 2) + '\n');
console.log(`Synced ${Object.keys(icons).length} WhoDB glyphs for ${Object.keys(aliases).length} launcher icon names.`);
