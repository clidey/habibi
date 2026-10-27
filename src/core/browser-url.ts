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
