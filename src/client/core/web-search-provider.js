const preferenceKey = 'habibi.web-search-provider';

export const webSearchProviders = [
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
  { id: 'ecosia', name: 'Ecosia', url: 'https://www.ecosia.org/search?q=' },
];

export function getWebSearchProvider() {
  try {
    const saved = localStorage.getItem(preferenceKey);
    return webSearchProviders.some(provider => provider.id === saved) ? saved : 'google';
  } catch { return 'google'; }
}

export function setWebSearchProvider(id) {
  if (!webSearchProviders.some(provider => provider.id === id)) return false;
  try { localStorage.setItem(preferenceKey, id); return true; }
  catch { return false; }
}

export function webSearchDestination(query, id = getWebSearchProvider()) {
  const provider = webSearchProviders.find(item => item.id === id) || webSearchProviders[0];
  return { name: provider.name, url: `${provider.url}${encodeURIComponent(query)}` };
}
