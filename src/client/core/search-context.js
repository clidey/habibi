// Small, session-only metadata cache. Global search never polls providers or runs a model.
const contexts = new Map();
export function cacheSearchContext(source, items) {
  contexts.set(source, items.slice(0, 200));
}
export function searchContext(query) {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  return [...contexts.values()].flat().filter((item) => tokens.every((token) => `${item.title} ${item.meta}`.toLocaleLowerCase().includes(token))).slice(0, 12);
}
