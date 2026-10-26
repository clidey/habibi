import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml } from '../../core/view-helpers.js';

export function installSearchSettings(target) {
  const section = document.createElement('section');
  section.className = 'settings-section search-settings';
  setHtml(section, `<div class="appearance-heading"><span class="briefing-heading">05 / LOCAL SEARCH</span><small>Find files by name.</small></div>
    <div class="search-index-card">
      <div class="search-index-summary">
        <span class="search-index-copy"><b>Files on this Mac</b><small id="local-index-status" aria-live="polite">Starts on your first file search.</small></span>
        <button class="secondary" id="refresh-search-index" type="button">Refresh index</button>
      </div>
      <div class="search-index-coverage">
        <p id="local-index-scope">Searches Desktop, Documents, Downloads, Projects, Developer and Code.</p>
        <p class="search-index-notice" id="local-index-notice" hidden></p>
        <details><summary>Search coverage</summary><p>Includes up to 30,000 files and folders, 4,000 folders per location, and 8 folder levels. Hidden folders, app bundles, dependencies, and build outputs are excluded.</p><p>Updates when files change. No periodic scans or AI requests.</p></details>
      </div>
    </div>`);
  target.append(section);
  const status = section.querySelector('#local-index-status');
  const button = section.querySelector('#refresh-search-index');
  function render(data) {
    if (!section.isConnected || !data.ok) return;
    status.textContent = `${Number(data.indexed || 0).toLocaleString()} items indexed · ${data.indexing ? 'Indexing…' : data.indexed ? 'Ready' : 'Starts on first search'}`;
    const roots = (data.roots || []).join(', ');
    section.querySelector('#local-index-scope').textContent = roots ? `Searches ${roots}.` : 'Starts on your first file search.';
    const notice = section.querySelector('#local-index-notice');
    notice.textContent = [data.truncated ? 'Index limit reached. Some files are not included.' : '', data.unavailableRoots?.length ? 'Some folders could not be accessed.' : ''].filter(Boolean).join(' ');
    notice.hidden = !notice.textContent;
  }
  fetch('/api/search/status').then((response) => response.json()).then(render).catch(() => { if (status.isConnected) status.textContent = 'Index status unavailable. Try refreshing.'; });
  button.onclick = async () => {
    button.disabled = true;
    status.textContent = 'Refreshing your filename index…';
    try { render(await fetch('/api/search/refresh', { method: 'POST' }).then((response) => response.json())); }
    catch { status.textContent = 'Could not refresh. Try again.'; }
    finally { button.disabled = false; }
  };
}
