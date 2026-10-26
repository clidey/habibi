import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml } from '../../core/view-helpers.js';

export function createSearchSources({
  input,
  resultsView,
  count,
  resultButton,
  refreshIcons,
  syncResultsLayout,
  getAppSequence,
  getLocalSequence,
}) {
  let controller = new AbortController();
  const cancel = () => { controller.abort(); controller = new AbortController(); };
  const recount = () => { if (!resultsView.querySelector('.result.selected')) resultsView.querySelector('.result')?.classList.add('selected'); count.textContent = `${resultsView.querySelectorAll('.result').length} results`; };
  async function searchApplications(query, staticItems, sequence) {
    try {
      const response = await fetch(`/api/apps?q=${encodeURIComponent(query)}`, { signal: controller.signal });
      const data = await response.json();
      if (sequence !== getAppSequence() || input.value !== query) return;
      const apps = (data.apps || []).map((app) => ({
        icon: 'agents',
        title: app.name,
        meta: `macOS application · ${app.path.startsWith('/Applications/') ? 'Applications' : 'installed on this Mac'}`,
        tag: 'APP',
        type: 'app',
        path: app.path,
        appIcon: `/api/app-icon?path=${encodeURIComponent(app.path)}`,
      }));
      const bestRegion = resultsView.querySelector('.best-matches-region');
      if (!bestRegion) return;
      const appRegion = resultsView.querySelector('.application-search-section');
      if (!appRegion) return;
      setHtml(appRegion, apps.length ? `<div class="result-header"><b>Applications</b><span>${apps.length} found</span></div><div class="result-list">${apps.slice(0, 4).map((app, index) => resultButton(app, staticItems.length + index)).join('')}</div>` : '');
      syncResultsLayout();
      recount();
      refreshIcons();
    } catch (_) {
      /* App discovery is optional; local search continues. */
    }
  }

  async function searchLocalFiles(query, baseCount, sequence) {
    try {
      const fileQuery =
        query
          .replace(/^(?:find|search|show|open)\s+(?:my\s+)?/i, '')
          .replace(/\b(?:files?|folders?|documents?)\b/gi, '')
          .replace(/\s+/g, ' ')
          .trim() || query;
      const response = await fetch(`/api/files?q=${encodeURIComponent(fileQuery)}`, { signal: controller.signal });
      const files = await response.json();
      if (!input.value || input.value !== query || sequence !== getLocalSequence()) return;
      const section = resultsView.querySelector('.local-files-section');
      const slot = resultsView.querySelector('.local-files-slot');
      if (!section || !slot) return;
      const fileResults = files.map((file) => ({
        icon: 'files',
        glyph: '⌁',
        title: file.name,
        meta: `${file.folder} · ${file.directory}`,
        tag: 'FILE',
        type: 'file',
        path: file.path,
      }));
      section.setAttribute('aria-busy', 'false');
      // A selected best match owns keyboard focus. Local results only become
      // selected when they are the first available search result.
      setHtml(
        slot,
        fileResults.length
          ? `<div class="inline-section"><div class="result-header"><b>Local files</b><span>Local index · ${fileResults.length} match${fileResults.length === 1 ? '' : 'es'} <kbd>⌘ ↓</kbd></span></div><div class="result-list">${fileResults.map((file, index) => resultButton(file, baseCount + index)).join('')}</div></div>`
          : `<div class="local-files-empty">No local files found for “${escapeHtml(query)}”.</div>`,
      );
      syncResultsLayout();
      recount();
      refreshIcons();
    } catch (error) {
      if (error.name === 'AbortError' || sequence !== getLocalSequence()) return;
      const section = resultsView.querySelector('.local-files-section');
      const slot = resultsView.querySelector('.local-files-slot');
      if (section && slot) {
        section.setAttribute('aria-busy', 'false');
        setHtml(
          slot,
          '<div class="local-files-empty">Local file search is unavailable right now.</div>',
        );
        syncResultsLayout();
      }
    }
  }

  return { cancel, searchApplications, searchLocalFiles };
}
