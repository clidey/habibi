import { escapeHtml } from './view-helpers.js';

export function isExplicitFileQuery(query) {
  return /(?:^~?\/|[\\/]|\.[a-z0-9]{2,5}\b)/i.test(query.trim());
}

export function isConversationalQuery(query) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  return words.length >= 2 && !isExplicitFileQuery(query);
}

/** A small safe Markdown subset for model responses. */
export function renderAssistantMarkdown(text = '') {
  const inline = (value) =>
    escapeHtml(value)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  const lines = String(text).replace(/\r/g, '').split('\n');
  const output = [];
  let list = null;
  const closeList = () => {
    if (list) {
      output.push(`</${list}>`);
      list = null;
    }
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      const nextList = numbered ? 'ol' : 'ul';
      if (list !== nextList) {
        closeList();
        list = nextList;
        output.push(`<${list}>`);
      }
      output.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      continue;
    }
    closeList();
    if (!line) continue;
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    output.push(heading ? `<h3>${inline(heading[1])}</h3>` : `<p>${inline(line)}</p>`);
  }
  closeList();
  return output.join('') || `<p>${inline(text)}</p>`;
}
