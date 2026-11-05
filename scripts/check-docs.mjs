import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { docs, doryRoot, requireDory, pages } from './docs-project.mjs';

const matter = requireDory('gray-matter');
const { tsImport } = await import(
  pathToFileURL(requireDory.resolve('tsx/esm/api').replace(/\.cjs$/, '.mjs')).href
);
const { verifyMdxContent } = await tsImport(
  pathToFileURL(path.join(doryRoot, 'src/mdx/processor.ts')).href,
  pathToFileURL(path.join(doryRoot, 'bin/dist/dory.js')).href,
);
const config = JSON.parse(await fs.readFile(path.join(docs, 'dory.json'), 'utf8'));
const files = await pages();
const keyOf = (file) =>
  path
    .relative(docs, file)
    .replaceAll(path.sep, '/')
    .replace(/\.mdx$/, '');
const keys = new Set(files.map(keyOf));
const navigation = config.navigation.tabs.flatMap((tab) =>
  tab.groups.flatMap((group) =>
    group.pages.map((page) => (typeof page === 'string' ? page : page.page)),
  ),
);
const failures = [];
if (!config.name || !config.description || !config.favicon)
  failures.push('Site name, description, and favicon are required.');
if (new Set(navigation).size !== navigation.length)
  failures.push('Navigation contains duplicate pages.');
for (const key of navigation) if (!keys.has(key)) failures.push(`Navigation page missing: ${key}`);
for (const key of keys)
  if (!navigation.includes(key)) failures.push(`Page missing from navigation: ${key}`);
async function checkLink(link, file) {
  if (/^(?:https?:|mailto:|#)/.test(link)) return;
  if (/^[a-z][a-z0-9+.-]*:/i.test(link)) {
    failures.push(`${keyOf(file)}: unsupported link ${link}`);
    return;
  }
  const clean = decodeURIComponent(link.split(/[?#]/)[0]);
  const target = clean.startsWith('/')
    ? path.resolve(docs, `.${clean}`)
    : path.resolve(path.dirname(file), clean);
  if (target !== docs && !target.startsWith(`${docs}${path.sep}`)) {
    failures.push(`${keyOf(file)}: link leaves documentation root: ${link}`);
    return;
  }
  try {
    await fs.access(path.extname(target) ? target : `${target}.mdx`);
  } catch {
    failures.push(`${keyOf(file)}: missing page or asset: ${link}`);
  }
}
for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  const { data, content } = matter(source);
  if (
    typeof data.title !== 'string' ||
    !data.title.trim() ||
    typeof data.description !== 'string' ||
    !data.description.trim()
  )
    failures.push(`${keyOf(file)}: title and description are required.`);
  const result = await verifyMdxContent(source, file);
  if (!result.valid) failures.push(`${keyOf(file)}: ${result.error?.message || 'Invalid MDX'}`);
  const prose = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const links = [...prose.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(
    (match) => match[1],
  );
  links.push(...[...prose.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((match) => match[1]));
  for (const link of links) await checkLink(link, file);
}
for (const link of [
  config.favicon,
  config.logo?.light,
  config.logo?.dark,
  config.image,
  config.fonts?.source,
  config.fonts?.mono?.source,
].filter(Boolean))
  await checkLink(link, path.join(docs, 'dory.json'));
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Documentation check passed: ${files.length} MDX pages, navigation, metadata, links, and local assets.`,
  );
