import { thisDevice } from '../../core/platform-copy.js';
import { noteIconName } from './note-icons.js';
import { setHtml } from '../../core/safe-dom.js';
import { notesDialog } from './notes-dialogs.js';
import { escapeHtml as e, icon, refreshIcons } from '../../core/view-helpers.js';
import { markdownLink, noteLink } from './notes-links.js';

const kinds = [['notes', 'Notes'], ['mail', 'Mail'], ['whatsapp', 'WhatsApp'], ['files', 'Files'], ['apps', 'Apps'], ['url', 'Web link']];
export function openNotesLinkPicker({ host, library, currentId, onInsert, query = '' }) {
  let category = 'notes'; let sequence = 0; let active = 0; const cache = new Map();
  const { root, close } = notesDialog(host, 'Link something', `<div class="notes-link-tabs" role="group" aria-label="Link type">${kinds.map(([id, label]) => `<button type="button" data-link-kind="${id}" aria-pressed="${id === 'notes'}">${label}</button>`).join('')}</div><label class="notes-dialog-field"><span class="notes-visually-hidden">Search links</span><input id="notes-link-search" placeholder="Find a note…" maxlength="500" /></label><div class="notes-link-results" id="notes-link-results" role="listbox" aria-label="Link targets"></div><p class="notes-link-help">Links open the original item in Habibi. Nothing is sent or copied from its contents.</p>`, () => {});
  const input = root.querySelector('#notes-link-search'); const results = root.querySelector('#notes-link-results');
  input.value = query;
  const choose = item => { if (item) { onInsert(item.markdown); close(); } };
  let shown = [];
  function highlight(index) {
    active = index;
    results.querySelectorAll('[data-link-result]').forEach((button, position) => { button.classList.toggle('selected', position === index); button.setAttribute('aria-selected', String(position === index)); });
  }
  function render(items) {
    if (!root.isConnected) return;
    shown = items.slice(0, 40); active = 0;
    setResults(shown.length ? shown.map((item, index) => `<button type="button" role="option" aria-selected="${index === 0}" class="${index === 0 ? 'selected' : ''}" data-link-result="${index}"><span>${e(item.emoji || '')}${icon(item.icon || 'files')}</span><span><b>${e(item.title)}</b><small>${e(item.meta || '')}</small></span>${icon('arrow-up-right')}</button>`).join('') : '<p class="notes-picker-empty">No matching items. Try another search or link type.</p>');
    results.querySelectorAll('[data-link-result]').forEach(button => { button.onclick = () => choose(shown[Number(button.dataset.linkResult)]); });
    refreshIcons();
  }
  function setResults(html) { if (!root.isConnected) return; setHtml(results, html); results.querySelectorAll('[data-link-result]').forEach(button => { button.onclick = () => choose(shown[Number(button.dataset.linkResult)]); }); refreshIcons(); }
  async function fetchItems(kind) {
    if (cache.has(kind)) return cache.get(kind);
    let items = [];
    if (kind === 'mail') {
      const status = await fetch('/api/mail/status').then(response => response.json());
      const accounts = (status.accounts || []).filter(account => account.connected);
      if (!accounts.length) throw new Error('Connect a mail account first. Your notes will stay here.');
      const batches = await Promise.allSettled(accounts.map(async account => {
        const data = await fetch(`/api/mail/threads?provider=${encodeURIComponent(account.id)}`).then(response => response.json());
        if (!data.ok) throw new Error('This mail account could not be read.');
        return (data.threads || []).map(thread => ({ title: thread.subject || '(No subject)', meta: `${thread.from || ''} · ${account.email || account.label || 'Mail'}`, icon: 'mail', markdown: markdownLink(thread.subject || '(No subject)', `habibi://mail/${encodeURIComponent(account.id)}/${encodeURIComponent(thread.id)}`) }));
      }));
      items = batches.filter(result => result.status === 'fulfilled').flatMap(result => result.value);
      if (!items.length && batches.some(result => result.status === 'rejected')) throw new Error('Could not read recent mail. Try reconnecting your account.');
    } else if (kind === 'whatsapp') {
      const data = await fetch('/api/whatsapp/chats').then(response => response.json());
      if (!data.ok) throw new Error('Link WhatsApp first to choose a conversation.');
      items = (data.chats || []).filter(chat => chat.kind !== 'status').map(chat => ({ title: chat.name || chat.id, meta: 'WhatsApp conversation', icon: 'whatsapp', markdown: markdownLink(chat.name || 'WhatsApp conversation', `habibi://whatsapp/${encodeURIComponent(chat.id)}`) }));
    } else if (kind === 'apps') {
      items = [['mail', 'Mail'], ['whatsapp', 'WhatsApp'], ['calendar', 'Calendar'], ['whodb', 'WhoDB'], ['emoji', 'Emoji'], ['teleprompter', 'Teleprompter'], ['ask', 'Ask Habibi']].map(([id, title]) => ({ title, meta: 'Open workspace', icon: 'boxes', markdown: markdownLink(title, `habibi://workspace/${id}`) }));
    }
    cache.set(kind, items); return items;
  }
  async function search() {
    const token = ++sequence; const kind = category; const needle = input.value.trim();
    if (kind === 'notes') return render(library.notes.filter(note => !note.deletedAt && note.id !== currentId && `${note.title} ${note.body}`.toLowerCase().includes(needle.toLowerCase())).map(note => ({ title: note.title || 'Untitled', meta: 'Local note', icon: noteIconName(note), markdown: noteLink(note) })));
    if (kind === 'url') {
      let url; try { url = new URL(needle); } catch { /* Wait for a full website address. */ }
      return render(url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? [{ title: url.hostname, meta: url.href, icon: 'arrow-up-right', markdown: markdownLink(url.hostname, url.href.replace(/>/g, '%3E')) }] : []);
    }
    if (kind === 'files' && needle.length < 2) { setResults(`<p class="notes-picker-empty">Type at least two characters to search filenames on ${thisDevice()}.</p>`); return; }
    setResults('<p class="notes-picker-empty">Loading…</p>');
    try {
      let items;
      if (kind === 'files') {
        const data = await fetch(`/api/files?q=${encodeURIComponent(needle)}`).then(response => response.json());
        const files = Array.isArray(data) ? data : data.files || [];
        items = files.map(file => ({ title: file.name || file.title || file.path?.split('/').at(-1), meta: file.path, icon: 'file', markdown: markdownLink(file.name || file.title || 'File', `habibi://file?path=${encodeURIComponent(file.path)}`) }));
      } else items = (await fetchItems(kind)).filter(item => `${item.title} ${item.meta}`.toLowerCase().includes(needle.toLowerCase()));
      if (token === sequence && root.isConnected) render(items);
    } catch (error) { if (token === sequence && root.isConnected) setResults(`<p class="notes-picker-empty">${e(error.message)}</p>`); }
  }
  let timer;
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(search, 150); };
  input.onkeydown = event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); if (shown.length) highlight((active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length); }
    if (event.key === 'Enter') { event.preventDefault(); choose(shown[active]); }
  };
  root.querySelectorAll('[data-link-kind]').forEach(button => { button.onclick = () => {
    category = button.dataset.linkKind; shown = []; input.value = '';
    root.querySelectorAll('[data-link-kind]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    input.placeholder = category === 'url' ? 'https://example.com' : category === 'mail' ? 'Filter recent mail by subject or sender…' : `Find ${category}…`;
    input.focus(); search();
  }; });
  search(); input.focus();
}
