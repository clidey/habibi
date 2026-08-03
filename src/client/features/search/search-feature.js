import { isConversationalQuery } from '../../core/query.js';

/** Local command matching plus debounced Spotlight searching. */
export function createSearchFeature({ input, defaultView, resultsView, count, results, resultButton, refreshIcons }) {
  let localSearchSequence = 0;
  let localSearchTimer = null;

  async function searchLocalFiles(query, baseCount, sequence) {
    try {
      const response = await fetch(`/api/files?q=${encodeURIComponent(query.replace(/^(find|file)\s+/i, ''))}`);
      const files = await response.json();
      if (!input.value || input.value !== query || sequence !== localSearchSequence) return;
      const section = resultsView.querySelector('.local-files-section');
      const slot = resultsView.querySelector('.local-files-slot');
      if (!section || !slot) return;
      const fileResults = files.map(file => ({ icon:'files', glyph:'⌁', title:file.name, meta:`${file.folder} · ${file.directory}`, tag:'FILE', type:'file', path:file.path }));
      section.setAttribute('aria-busy', 'false');
      // A selected best match owns keyboard focus. Local results only become
      // selected when they are the first available search result.
      slot.innerHTML = fileResults.length ? `<div class="inline-section"><div class="result-header"><b>Local files</b><span>Spotlight index · ${fileResults.length} match${fileResults.length === 1 ? '' : 'es'} <kbd>⌘ ↓</kbd></span></div><div class="result-list">${fileResults.map((file, index) => resultButton(file, baseCount + index)).join('')}</div></div>` : `<div class="local-files-empty">No local files found for “${query}”.</div>`;
      count.textContent = `${baseCount + fileResults.length} results`;
      refreshIcons();
    } catch (_) {
      if (sequence !== localSearchSequence) return;
      const section = resultsView.querySelector('.local-files-section');
      const slot = resultsView.querySelector('.local-files-slot');
      if (section && slot) { section.setAttribute('aria-busy', 'false'); slot.innerHTML = '<div class="local-files-empty">Local file search is unavailable right now.</div>'; }
    }
  }

  function renderSearch(query) {
    const q = query.toLowerCase();
    const folderQuery = q.replace(/^(?:open|show|go to|find)\s+/, '').replace(/\s+folder$/, '').trim();
    const folders = {
      downloads:{ title:'Downloads', meta:'Open your Downloads folder', folder:'Downloads' },
      documents:{ title:'Documents', meta:'Open your Documents folder', folder:'Documents' },
      desktop:{ title:'Desktop', meta:'Open your Desktop folder', folder:'Desktop' },
      home:{ title:'Home folder', meta:'Open your home folder', folder:'Home' },
    };
    const folderKey = folderQuery.length >= 3 && Object.keys(folders).find(name => name.startsWith(folderQuery));
    const folderIntent = folderKey ? { icon:'files', glyph:'⌁', tag:'FOLDER', type:'folder', ...folders[folderKey] } : null;
    const wordCount = query.trim().split(/\s+/).filter(Boolean).length;
    const isFileTypeSearch = ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'md'].includes(q);
    const naturalMessage = /^message\s+.+\s+(?:on\s+)?whatsapp(?:\s|$)/i.test(query);
    const conversational = isConversationalQuery(query);
    const specific = isFileTypeSearch ? [] : naturalMessage ? [{ icon:'agents', title:'Ask Habibi to prepare this WhatsApp message', meta:'AI · resolves the recipient locally, then shows the real chat before sending', tag:'AI', type:'assistant' }, results.find(x => x.type === 'whatsapp')] : conversational ? [{ icon:'agents', title:'Ask Habibi about this', meta:'Chat-first · interpret your request against local capabilities', tag:'AI', type:'assistant' }, results.find(x => x.type === 'whatsapp')] : /^(?:w|wh|wha|what|whats|whatsapp)/.test(q) ? results.filter(x => x.type === 'whatsapp') : q.includes('message') ? results.filter(x => x.type === 'whatsapp') : q.includes('event') || q.includes('calendar') ? results.filter(x => x.type === 'event' || x.type === 'agenda') : q.includes('codex') || q.includes('claude') || q.includes('agent') ? results.filter(x => x.type === 'agent') : q.includes('mail') || q.includes('email') ? results.filter(x => x.type === 'email') : q.includes('file') || q.includes('folder') || q.includes('document') ? results.filter(x => x.type === 'file') : results.filter(x => !q || `${x.title} ${x.meta}`.toLowerCase().includes(q));
    // Never pad an active search with unrelated apps. The empty launcher can
    // offer capability suggestions; a user query must earn every result.
    const list = folderIntent ? [folderIntent] : specific.length ? specific : isFileTypeSearch ? [] : query ? results.filter(item => `${item.title} ${item.meta}`.toLowerCase().includes(q)) : results.slice(0, 3);
    defaultView.classList.add('hidden'); resultsView.classList.remove('hidden');
    const bestMarkup = list.length ? `<div class="result-header"><b>${query ? 'Best matches' : 'Recent and suggested'}</b><span>${list.length} result${list.length === 1 ? '' : 's'}</span></div><div class="result-list">${list.map(resultButton).join('')}</div>` : '';
    const bestKey = list.map(item => `${item.type}:${item.title}`).join('|');
    let bestRegion = resultsView.querySelector('.best-matches-region');
    let localSection = resultsView.querySelector('.local-files-section');
    if (!bestRegion || !localSection) {
      resultsView.innerHTML = '<section class="best-matches-region"></section><section class="local-files-section" aria-live="polite"><div class="local-files-slot"></div></section>';
      bestRegion = resultsView.querySelector('.best-matches-region');
      localSection = resultsView.querySelector('.local-files-section');
    }
    if (bestRegion.dataset.key !== bestKey) { bestRegion.innerHTML = bestMarkup; bestRegion.dataset.key = bestKey; refreshIcons(); }
    const localSlot = localSection.querySelector('.local-files-slot');
    const shouldSearchFiles = q.length >= 2 && !(conversational && wordCount > 7);
    clearTimeout(localSearchTimer);
    localSection.setAttribute('aria-busy', String(shouldSearchFiles));
    if (!shouldSearchFiles) { localSearchSequence += 1; localSlot.innerHTML = ''; }
    count.textContent = `${list.length} results`;
    if (shouldSearchFiles) {
      const sequence = ++localSearchSequence;
      localSearchTimer = setTimeout(() => {
        if (sequence !== localSearchSequence || input.value !== query) return;
        if (!localSlot.innerHTML.trim()) localSlot.innerHTML = '<div class="local-files-loading"><span class="mini-spinner"></span>Finding local files…</div>';
        searchLocalFiles(query, list.length, sequence);
      }, 220);
    }
  }

  return { renderSearch, searchLocalFiles };
}
