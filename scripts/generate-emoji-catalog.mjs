import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regenerate with: node scripts/generate-emoji-catalog.mjs
// Optional local source files make regeneration possible without a network request.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  'https://www.unicode.org/Public/18.0.0/emoji/emoji-test.txt',
  'https://raw.githubusercontent.com/unicode-org/cldr/release-49/common/annotations/en.xml',
];

async function source(index) {
  if (process.argv[index + 2]) return fs.readFile(process.argv[index + 2], 'utf8');
  const response = await fetch(sources[index]);
  if (!response.ok) throw new Error(`Could not fetch ${sources[index]}: ${response.status}`);
  return response.text();
}

function decodeXml(value) {
  return value.replace(/&(?:#(x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos);/gi, (entity, numeric) => {
    if (numeric) return String.fromCodePoint(numeric[0].toLowerCase() === 'x'
      ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10));
    return { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity] || entity;
  });
}

function annotationMap(xml) {
  const map = new Map();
  for (const [, encoded, kind, value] of xml.matchAll(/<annotation cp="([^"]+)"(?: type="(tts)")?>([^<]*)<\/annotation>/g)) {
    const key = decodeXml(encoded).replaceAll('\ufe0f', '');
    const entry = map.get(key) || { keywords: [] };
    if (kind) entry.name = decodeXml(value);
    else entry.keywords = decodeXml(value).split(' | ');
    map.set(key, entry);
  }
  return map;
}

const [emojiText, annotationText] = await Promise.all([source(0), source(1)]);
if (!emojiText.includes('# Version: 18.0')) throw new Error('Expected Unicode Emoji 18.0');
const annotations = annotationMap(annotationText);
const entries = [];
let group = '';
let subgroup = '';
for (const line of emojiText.split(/\r?\n/)) {
  if (line.startsWith('# group: ')) group = line.slice(9);
  if (line.startsWith('# subgroup: ')) subgroup = line.slice(12);
  const match = line.match(/^([0-9A-F ]+)\s*;\s*(fully-qualified|component)\s*#\s*\S+\s+E([\d.]+)\s+(.+)$/);
  if (!match) continue;
  const emoji = match[1].trim().split(/\s+/).map(point => String.fromCodePoint(Number.parseInt(point, 16))).join('');
  const annotation = annotations.get(emoji.replaceAll('\ufe0f', ''));
  const entry = { e: emoji, n: annotation?.name || match[4], g: group, s: subgroup,
    k: annotation?.keywords || [] };
  if (Number.parseFloat(match[3]) > 17) entry.v = match[3];
  entries.push(entry);
}

const byEmoji = new Map(entries.map(entry => [entry.e, entry]));
const byName = new Map(entries.map(entry => [entry.n.toLowerCase(), entry]));
for (const entry of entries) {
  const noTone = [...entry.e].filter(point => !/^[\u{1F3FB}-\u{1F3FF}]$/u.test(point)).join('');
  let parent = noTone !== entry.e ? byEmoji.get(noTone) : null;
  if (!parent && /^(man|woman)\s/i.test(entry.n)) {
    const neutral = entry.n.replace(/^(man|woman)\s/i, 'person ');
    const role = entry.n.replace(/^(man|woman)\s/i, '');
    parent = byName.get(neutral.toLowerCase()) || byName.get(role.toLowerCase());
  }
  if (parent && parent !== entry) entry.b = parent.e;
}
for (const entry of entries) {
  let parent = entry.b && byEmoji.get(entry.b);
  while (parent?.b) parent = byEmoji.get(parent.b);
  if (parent) entry.b = parent.e;
}
if (entries.length < 3900 || new Set(entries.map(entry => entry.e)).size !== entries.length)
  throw new Error(`Unexpected or duplicate emoji catalog: ${entries.length}`);

const output = path.join(root, 'assets/emoji-catalog.json');
await fs.writeFile(output, JSON.stringify({ version: '18.0', locale: 'en', entries }) + '\n');
console.log(`Generated ${entries.length} emoji in ${output}`);
