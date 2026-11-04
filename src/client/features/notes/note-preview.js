import { lexer } from 'marked';

function text(tokens = []) {
  return tokens.map(token => {
    if (token.type === 'table') return 'Table';
    if (token.type === 'code') return 'Code block';
    if (token.type === 'image') return token.text || 'Image';
    if (token.type === 'space' || token.type === 'hr') return '';
    if (token.type === 'list') return token.items.map(item => text(item.tokens)).join(' ');
    if (token.tokens) return text(token.tokens);
    return (token.text || '').replace(/<[^>]*>/g, '');
  }).filter(Boolean).join(' ');
}

/** Show readable prose and structural labels, never Markdown table cells or delimiters. */
export function notePreview(note) {
  return lexer(note.body.slice(0, 6000), { gfm: true }).map(token => text([token]).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ').slice(0, 110) || 'Empty note';
}
