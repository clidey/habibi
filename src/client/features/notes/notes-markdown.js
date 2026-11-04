import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { escapeHtml } from '../../core/view-helpers.js';
import { parseNoteReference } from './notes-links.js';

function parserFor(notes = []) {
  return new Marked({ gfm: true, breaks: false, async: false,
    extensions: [{ name: 'wikilink', level: 'inline', start: source => source.indexOf('[['),
      tokenizer(source) { const match = /^\[\[([^\]\n]{1,200})\]\]/.exec(source); if (match) return { type: 'wikilink', raw: match[0], text: match[1] }; },
      renderer(token) {
        const [title, alias] = token.text.split('|');
        const note = notes.find(item => item.title.toLowerCase() === title.trim().toLowerCase());
        return note ? `<a href="habibi://note/${escapeHtml(note.id)}" class="notes-wikilink">${escapeHtml(alias || title)}</a>` : `<button type="button" class="notes-missing-link" data-missing-note="${escapeHtml(title.trim())}">${escapeHtml(alias || title)}</button>`;
      },
    }],
    renderer: {
      link({ href, title, tokens }) {
        const ref = parseNoteReference(href);
        const label = this.parser.parseInline(tokens);
        return ref ? `<a href="${escapeHtml(ref.href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>` : label;
      },
      image({ href, text }) {
        const ref = parseNoteReference(href);
        return ref?.type === 'web' && ref.url.startsWith('https:') ? `<button type="button" class="notes-load-image" data-note-image="${escapeHtml(ref.url)}">Load image: ${escapeHtml(text || 'Image')}</button>` : escapeHtml(text || 'Image');
      },
      html({ text }) { return escapeHtml(text); },
    },
  });
}

/** Markdown is untrusted; raw HTML stays text and remote images require a click. */
export function renderNoteMarkdown(target, body, notes) {
  const html = parserFor(notes).parse(body);
  target.innerHTML = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'strong', 'em', 'del', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'input', 'button', 'span'],
    ALLOWED_ATTR: ['href', 'title', 'class', 'type', 'checked', 'disabled', 'start', 'align', 'data-missing-note', 'data-note-image'],
    ADD_URI_SAFE_ATTR: ['type'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|habibi):|#)/i,
  });
}
const cache = new Map();
export function noteReferences(note, notes) {
  let entry = cache.get(note.id);
  if (!entry || entry.body !== note.body) {
    const parser = parserFor(); const refs = [];
    parser.walkTokens(parser.lexer(note.body), token => {
      if (token.type === 'link') { const ref = parseNoteReference(token.href); if (ref) refs.push({ ...ref, label: token.text }); }
      if (token.type === 'wikilink') refs.push({ type: 'wiki', title: token.text.split('|')[0].trim() });
    });
    entry = { body: note.body, refs }; cache.set(note.id, entry);
    if (cache.size > 6000) cache.delete(cache.keys().next().value);
  }
  return entry.refs.map(ref => {
    if (ref.type !== 'wiki') return ref;
    const target = notes.find(item => item.title.toLowerCase() === ref.title.toLowerCase());
    return target ? { type: 'note', id: target.id, href: `habibi://note/${target.id}`, label: target.title } : null;
  }).filter(Boolean).filter((ref, index, all) => all.findIndex(item => item.href === ref.href) === index);
}
