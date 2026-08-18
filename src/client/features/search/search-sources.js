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
  async function searchApplications(query, staticItems, sequence) {
    try {
      const response = await fetch(`/api/apps?q=${encodeURIComponent(query)}`);
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
      // A connected workspace is more useful than simply launching the same
      // app. Lead with Habibi's embedded surface, then offer the native app
      // immediately after it (WhatsApp and Mail follow the same contract).
      const preferences = staticItems.filter((item) => item.type === 'preferences');
      const embedded = staticItems.filter((item) =>
        ['whatsapp', 'email', 'kubernetes', 'codex', 'claude', 'agent'].includes(item.type),
      );
      const remaining = staticItems.filter(
        (item) => !preferences.includes(item) && !embedded.includes(item),
      );
      // Keep the command launcher balanced: broad application prefixes can
      // match dozens of apps, but the first three are enough to decide. The
      // rest of the panel remains available for the relevant local files.
      const all = [...preferences, ...embedded, ...apps, ...remaining];
      const best = all.slice(0, 3);
      setHtml(
        bestRegion,
        best.length
          ? `<div class="result-header"><b>Best matches</b><span>${best.length} result${best.length === 1 ? '' : 's'}</span></div><div class="result-list">${best.map(resultButton).join('')}</div>`
          : '',
      );
      bestRegion.dataset.key = `apps:${best.map((app) => app.path || app.title).join('|')}|${staticItems.map((item) => `${item.type}:${item.title}`).join('|')}`;
      syncResultsLayout();
      count.textContent = `${best.length} results`;
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
      const response = await fetch(`/api/files?q=${encodeURIComponent(fileQuery)}`);
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
          ? `<div class="inline-section"><div class="result-header"><b>Local files</b><span>Spotlight index · ${fileResults.length} match${fileResults.length === 1 ? '' : 'es'} <kbd>⌘ ↓</kbd></span></div><div class="result-list">${fileResults.map((file, index) => resultButton(file, baseCount + index)).join('')}</div></div>`
          : `<div class="local-files-empty">No local files found for “${escapeHtml(query)}”.</div>`,
      );
      syncResultsLayout();
      count.textContent = `${baseCount + fileResults.length} results`;
      refreshIcons();
    } catch (_) {
      if (sequence !== getLocalSequence()) return;
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

  return { searchApplications, searchLocalFiles };
}
