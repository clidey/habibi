export const categories = [
  { id: 'all', label: 'All', mark: '✨' },
  { id: 'recent', label: 'Recent', mark: '◷' },
  { id: 'smileys', label: 'Smileys', mark: '😀' },
  { id: 'hands', label: 'Hands', mark: '👍' },
  { id: 'people', label: 'People', mark: '🧑' },
  { id: 'nature', label: 'Nature', mark: '🌿' },
  { id: 'food', label: 'Food', mark: '☕' },
  { id: 'places', label: 'Places', mark: '🚀' },
  { id: 'activities', label: 'Activities', mark: '🎯' },
  { id: 'objects', label: 'Objects', mark: '💡' },
  { id: 'symbols', label: 'Symbols', mark: '✅' },
  { id: 'flags', label: 'Flags', mark: '🏳️' },
  { id: 'components', label: 'Modifiers', mark: '🏻' },
];

export function categoryId(entry) {
  if (entry.g === 'Smileys & Emotion') return 'smileys';
  if (entry.g === 'People & Body') return entry.s.startsWith('hand-') || ['hands', 'body-parts'].includes(entry.s) ? 'hands' : 'people';
  return {
    'Animals & Nature': 'nature', 'Food & Drink': 'food', 'Travel & Places': 'places',
    Activities: 'activities', Objects: 'objects', Symbols: 'symbols', Flags: 'flags',
    Component: 'components',
  }[entry.g] || 'symbols';
}

export function createCatalog(entries) {
  const byEmoji = new Map(entries.map(entry => [entry.e, entry]));
  const variants = new Map();
  for (const entry of entries) {
    const root = entry.b || entry.e;
    if (!variants.has(root)) variants.set(root, []);
    variants.get(root).push(entry);
  }
  const base = entries.filter(entry => !entry.b);
  const indexed = entries.map(entry => ({ entry,
    text: `${entry.n} ${entry.k.join(' ')} ${entry.s.replaceAll('-', ' ')}`.toLowerCase(),
  }));
  return { entries, base, byEmoji, variants, indexed };
}

export function searchEmoji(catalog, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return catalog.indexed.filter(({ entry, text }) => entry.e === query || words.every(word => text.includes(word)))
    .sort((a, b) => {
      const aName = a.entry.n.toLowerCase().startsWith(query.toLowerCase()) ? 0 : 1;
      const bName = b.entry.n.toLowerCase().startsWith(query.toLowerCase()) ? 0 : 1;
      return aName - bName;
    }).map(item => item.entry);
}

export function emojiSections(catalog, category, query, recent) {
  if (query.trim()) return [{ label: 'Search results', entries: searchEmoji(catalog, query) }];
  const recentEntries = recent.map(emoji => catalog.byEmoji.get(emoji)).filter(Boolean);
  if (category === 'recent') return [{ label: 'Recent', entries: recentEntries }];
  if (category !== 'all') return [{
    label: categories.find(item => item.id === category)?.label || 'Emoji',
    entries: catalog.base.filter(entry => categoryId(entry) === category),
  }];
  const sections = recentEntries.length ? [{ label: 'Recent', entries: recentEntries }] : [];
  for (const item of categories.slice(2)) {
    const entries = catalog.base.filter(entry => categoryId(entry) === item.id);
    if (entries.length) sections.push({ label: item.label, entries });
  }
  return sections;
}
