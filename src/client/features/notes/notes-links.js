const workspaces = new Set(['notes', 'mail', 'whatsapp', 'calendar', 'whodb', 'emoji', 'teleprompter', 'ask']);
export function parseNoteReference(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (['http:', 'https:'].includes(url.protocol)) return { type: 'web', url: url.href, href: url.href };
    if (url.protocol !== 'habibi:' || url.port) return null;
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (url.hostname === 'note' && parts.length === 1 && /^[a-f0-9-]{36}$/i.test(parts[0])) return { type: 'note', id: parts[0], href: `habibi://note/${parts[0]}` };
    if (url.hostname === 'mail' && parts.length === 2 && parts.every(part => part.length > 0 && part.length <= 256 && !/[\u0000-\u001f]/.test(part))) return { type: 'mail', accountId: parts[0], threadId: parts[1], href: `habibi://mail/${parts.map(encodeURIComponent).join('/')}` };
    if (url.hostname === 'whatsapp' && parts.length === 1 && /^[\w.+-]+@(?:c\.us|g\.us|s\.whatsapp\.net|lid)$/.test(parts[0])) return { type: 'whatsapp', id: parts[0], href: `habibi://whatsapp/${encodeURIComponent(parts[0])}` };
    if (url.hostname === 'workspace' && parts.length === 1 && workspaces.has(parts[0])) return { type: 'workspace', id: parts[0], href: `habibi://workspace/${parts[0]}` };
    const file = url.searchParams.get('path');
    if (url.hostname === 'file' && !parts.length && file?.startsWith('/') && !/[\u0000-\u001f]/.test(file)) return { type: 'file', path: file, href: `habibi://file?path=${encodeURIComponent(file)}` };
  } catch { /* Invalid references remain readable text. */ }
  return null;
}
export function sourceReference(source) {
  const href = source.type === 'mail' ? `habibi://mail/${encodeURIComponent(source.accountId)}/${encodeURIComponent(source.threadId)}` : source.type === 'whatsapp' ? `habibi://whatsapp/${encodeURIComponent(source.id)}` : source.href;
  return parseNoteReference(href);
}
export const markdownLink = (label, href) => `[${String(label).replace(/[\\[\]]/g, '\\$&').replace(/[\r\n]/g, ' ')}](<${href}>)`;
export const noteLink = note => markdownLink(note.title || 'Untitled', `habibi://note/${note.id}`);
export function quickCopyItems(body) {
  const items = []; const seen = new Set();
  const add = (type, value) => { if (value && value.length <= 8000 && !seen.has(value)) { seen.add(value); items.push({ type, value }); } };
  for (const match of body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) add('Code', match[1].trim());
  for (const match of body.matchAll(/`([^`\n]+)`/g)) add('Code', match[1]);
  for (const match of body.matchAll(/https?:\/\/[^\s<>\])]+/g)) { const ref = parseNoteReference(match[0]); if (ref) add('Link', ref.url); }
  for (const match of body.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)) add('Email', match[0]);
  return items.slice(0, 12);
}
