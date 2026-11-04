import { escapeHtml, icon } from '../../core/view-helpers.js';
import { categories } from './emoji-catalog.js';

export function emojiWorkspaceMarkup(shortcut) {
  const hint = shortcut ? `${escapeHtml(shortcut)} · anywhere` : 'SEARCH · PICK · COPY';
  return `<section class="emoji-workspace" aria-label="Emoji picker">
    <header class="emoji-header"><div><p class="eyebrow">HABIBI · EMOJI</p><h2>Pick an emoji</h2></div><span class="emoji-shortcut">${hint}</span></header>
    <nav class="emoji-categories" aria-label="Emoji categories">${categories.map((item, index) =>
      `<button type="button" class="emoji-category${index === 0 ? ' active' : ''}" data-emoji-category="${item.id}" aria-pressed="${index === 0}"><span aria-hidden="true">${item.mark}</span>${item.label}</button>`).join('')}</nav>
    <div class="emoji-scroll" id="emoji-scroll" aria-label="Emoji list"></div>
    <div class="emoji-variants" id="emoji-variants" role="dialog" aria-label="Emoji variants" hidden></div>
    <footer class="emoji-detail"><span class="emoji-detail-glyph" id="emoji-detail-glyph" aria-hidden="true"></span><span class="emoji-detail-copy"><b id="emoji-detail-name"></b><small id="emoji-detail-meta"></small></span><button type="button" class="emoji-variant-trigger" id="emoji-variant-trigger" aria-label="Choose a variant" hidden>${icon('chevron-down')}</button><button type="button" class="primary emoji-copy" id="emoji-copy">${icon('copy')} <span id="emoji-copy-label">Copy</span></button></footer>
  </section>`;
}

export function emojiSectionsMarkup(sections, selected) {
  const available = sections.some(section => section.entries.length);
  if (!available) return '<div class="emoji-empty">No emoji found. Try another word or category.</div>';
  return sections.filter(section => section.entries.length).map(section =>
    `<section class="emoji-section"><h3>${escapeHtml(section.label)}</h3><div class="emoji-grid">${section.entries.map(entry =>
      `<button type="button" class="emoji-tile${entry.e === selected ? ' selected' : ''}" data-emoji="${escapeHtml(entry.e)}" aria-label="${escapeHtml(entry.n)}" aria-pressed="${entry.e === selected}" tabindex="${entry.e === selected ? 0 : -1}"><span aria-hidden="true">${escapeHtml(entry.e)}</span></button>`).join('')}</div></section>`).join('');
}

export function emojiVariantsMarkup(entries, selected) {
  return `<div class="emoji-variants-heading"><b>Choose a variant</b><small>Enter to select · Esc to close</small></div><div class="emoji-variants-grid">${entries.map(entry =>
    `<button type="button" class="emoji-variant${entry.e === selected ? ' selected' : ''}" data-variant="${escapeHtml(entry.e)}" aria-label="${escapeHtml(entry.n)}" title="${escapeHtml(entry.n)}">${escapeHtml(entry.e)}</button>`).join('')}</div>`;
}
