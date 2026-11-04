/** Browser destinations only; never hand file paths, credentials, or custom schemes to `open`. */
export function browserUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\u0000-\u001f\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function browserCommand(command: unknown = ''): string | null {
  const value = String(command).trim().replace(/^(?:open|visit|go\s+to|browse(?:\s+to)?)\s+/i, '');
  if (/^https?:\/\//i.test(value)) return browserUrl(value);
  // A bare domain is a destination; common document suffixes remain local-file searches.
  if (!/^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,63}(?::\d{1,5})?(?:[/?#]|$)/u.test(value)) return null;
  if (/\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|md|json|js|ts|png|jpe?g|zip)$/i.test(value)) return null;
  return browserUrl(`https://${value}`);
}

export function requestedBrowserUrl(request: unknown, destination: unknown, { allowNamedWebsite = false }: { allowNamedWebsite?: boolean } = {}): string | null {
  const source = String(request || '');
  const url = browserUrl(destination);
  const supplied = new Set([source, ...source.split(/\s+/)].flatMap(value => {
    const clean = value.replace(/^["'(\[]+|["')\],.!]+$/g, '');
    return [browserCommand(value), browserCommand(clean)].filter(Boolean);
  }));
  if (url && supplied.has(url)) return url;
  if (!url || supplied.size || !allowNamedWebsite || !/\b(?:open|visit|browse|navigate|go\s+to|take\s+me\s+to)\b/i.test(source)) return null;
  const site = new URL(url);
  const publicHomepage = site.protocol === 'https:' && site.pathname === '/' && !site.search && !site.hash
    && site.hostname.includes('.') && !/\.(?:local|localhost|internal|test|invalid)$/.test(site.hostname)
    && !/^\d+(?:\.\d+){3}$/.test(site.hostname) && !site.hostname.includes(':');
  return publicHomepage ? url : null;
}

/** A model may propose a task page only when its site and search terms are grounded in the request. */
export function requestedWebsiteTaskUrl(request: unknown, destination: unknown): string | null {
  const source = String(request || '').trim();
  const url = browserUrl(destination);
  if (!url || !/\b(?:search|find|book|buy|tickets?|flights?|hotels?|buses?|from\b.+\bto)\b/i.test(source)) return null;
  // A typed URL or domain must continue through the exact-destination guard above.
  if ([source, ...source.split(/\s+/)].some(part => browserCommand(part.replace(/^["'(\[]+|["')\],.!]+$/g, '')))) return null;
  const candidate = new URL(url);
  const labels = candidate.hostname.toLowerCase().split('.');
  const brand = labels.at(-2);
  if (candidate.protocol !== 'https:' || candidate.port || candidate.hash || labels.length < 2 || !brand || brand.length < 4 ||
      !/^[a-z][a-z0-9-]+$/.test(brand) || ['co', 'com', 'org', 'net'].includes(brand) ||
      /\.(?:local|localhost|internal|test|invalid)$/.test(candidate.hostname) ||
      !new RegExp(`\\b${brand.replaceAll('-', '[ -]?')}\\b`, 'i').test(source) ||
      /\b(?:checkout|payment|pay|purchase|confirm|account|login|delete|admin|api)\b/i.test(candidate.pathname) ||
      (candidate.pathname === '/' && !candidate.search)) return null;
  let routeText: string;
  try { routeText = decodeURIComponent(candidate.pathname + candidate.search).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  catch { return null; }
  const sourceText = source.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Relative travel dates and extra filters cannot be checked against an
  // arbitrary site's private URL format. Search with the full request instead.
  if (/\b(?:today|tomorrow|tonight|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{4}-\d{2}-\d{2}\b/i.test(source)) return null;
  const journey = source.match(/\bfrom\s+([a-z][a-z -]{0,50}?)\s+to\s+([a-z][a-z -]{0,50}?)(?=\s+(?:on|for|today|tomorrow|next|with|via|at)\b|[?.!,]|$)/i);
  if (journey && (!routeText.includes(journey[1]!.toLowerCase().replace(/[^a-z0-9]/g, '')) ||
      !routeText.includes(journey[2]!.toLowerCase().replace(/[^a-z0-9]/g, '')))) return null;
  for (const value of candidate.searchParams.values()) {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized && !sourceText.includes(normalized)) return null;
  }
  for (const qualifier of source.matchAll(/\b(?:for|with)\s+([a-z0-9][a-z0-9 -]{0,80})(?=[?.!,]|$)/gi)) {
    const normalized = qualifier[1]!.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized && !routeText.includes(normalized)) return null;
  }
  const terms = source.toLowerCase().match(/[a-z]{4,}/g)?.filter(term =>
    !['open', 'show', 'find', 'book', 'search', 'from', 'with', 'that', 'this', 'website', 'online', 'please', brand].includes(term)) || [];
  return terms.some(term => routeText.includes(term)) ? url : null;
}
