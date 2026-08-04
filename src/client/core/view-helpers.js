import escapeHtmlLibrary from 'escape-html';

export const icon = name => `<i data-lucide="${escapeHtml(name)}"></i>`;

export const refreshIcons = () => {
  window.lucide?.createIcons({ attrs:{ 'stroke-width':1.8 } });
};

export const chatTime = timestamp => {
  const date = new Date(timestamp * 1000);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
    : date.toLocaleDateString([], { month:'short', day:'numeric' });
};

export const initials = name => String(name || '?')
  .split(/\s+/)
  .map(part => part[0])
  .join('')
  .slice(0, 2)
  .toUpperCase();

/**
 * Escapes the five characters that can break out of HTML text or a quoted
 * attribute. The implementation is the `escape-html` package, not our own:
 * esbuild inlines it into the browser bundle at build time.
 */
export const escapeHtml = value => escapeHtmlLibrary(String(value ?? ''));

/**
 * Image sources arrive from connectors and from disk, so escaping alone is not
 * enough: `escapeHtml` leaves a `javascript:` or `data:text/html` URL intact.
 *
 * Parsing with the platform `URL` rather than matching on the raw string is
 * deliberate — it normalizes the evasions a pattern would have to anticipate
 * (leading whitespace, embedded tabs and newlines, mixed-case schemes).
 */
const safeSrc = (value, kinds) => {
  let parsed;
  try { parsed = new URL(String(value ?? ''), window.location.origin); }
  catch { return ''; }
  if (parsed.protocol === 'data:') {
    // Only inline media of an expected type, and only well-formed base64 — a
    // `data:text/html` payload would otherwise execute in this origin.
    const pattern = new RegExp(`^data:(?:${kinds})/[\\w.+-]+;base64,[A-Za-z0-9+/]*={0,2}$`, 'i');
    return pattern.test(parsed.href) ? escapeHtml(parsed.href) : '';
  }
  return parsed.protocol === 'https:' || parsed.origin === window.location.origin ? escapeHtml(parsed.href) : '';
};

/** For `<img>`: same-origin paths, https, or an inline image. */
export const safeImageSrc = value => safeSrc(value, 'image');

/** For `<img>`/`<video>`/`<audio>`/document links from a chat connector. */
export const safeMediaSrc = value => safeSrc(value, 'image|video|audio|application');
