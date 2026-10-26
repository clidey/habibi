import { showWhoDbConnected } from './whodb-connected.js';
import { installWhoDbSignIn } from './whodb-sign-in.js';
import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons, spinner } from '../../core/view-helpers.js';

/** WhoDB view lifecycle; credentials stay in the server-owned connection. */
export function createWhoDbFeature({ input, defaultView, resultsView, count, notify, onOpen }) {
  let connectedView = null;
  let connection = {};
  function showSetup(status = connection) {
    onOpen();
    input.value = '';
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = 'WhoDB · workspace';
    const saved = status.host || localStorage.getItem('habibi.whodb.instance') || 'https://app.whodb.com';
    setHtml(resultsView, `<div class="workspace-heading"><span><p class="eyebrow">HABIBI · WHODB</p><h2>Your workspace</h2></span><span class="status-pill">${status.sessionError ? 'Sign in again' : status.connected ? 'Connected · read-only' : 'Not connected'}</span></div><section class="whodb-view whodb-setup"><p>Sign in to WhoDB to ask about your data and explore your organizations, projects, and apps.</p><div class="whodb-card"><div><label>Instance URL<input class="whodb-url" id="whodb-instance" type="url" placeholder="https://app.whodb.com" value="${escapeHtml(saved)}" autocomplete="url" /></label></div><div><span class="briefing-heading">YOUR WHODB WORKSPACE</span><ul class="whodb-checks"><li>${icon('check')} Explore your organizations, apps, and ontology</li><li>${icon('check')} Sign in securely in your browser</li><li>${icon('check')} Credentials stay in macOS Keychain</li></ul><button id="sign-in-whodb" class="primary">Sign in with SSO</button><div id="whodb-sign-in-status" aria-live="polite"></div><p class="settings-note">Sign in through your browser, just like the WhoDB CLI. Habibi only reads workspace data.</p><details><summary>Advanced: custom MCP connection</summary><label class="whodb-server-label">WhoDB MCP connection<select id="whodb-mcp-server">${(status.servers || []).map((server) => `<option value="${escapeHtml(server.id)}" ${status.serverId === server.id ? 'selected' : ''}>${escapeHtml(server.name)}</option>`).join('') || '<option value="">No MCP servers configured</option>'}</select></label><button id="connect-whodb-mcp" class="secondary" ${(status.servers || []).length ? '' : 'disabled'}>Connect MCP</button></details></div><div class="whodb-actions"><button id="save-whodb-instance" class="secondary">Save instance</button><a id="open-whodb-instance" class="secondary hidden" target="_blank" rel="noopener noreferrer">Open WhoDB ${icon('arrow-up-right')}</a></div></div></section>`);
    const field = document.querySelector('#whodb-instance');
    const link = document.querySelector('#open-whodb-instance');
    installWhoDbSignIn({ container: resultsView, field, notify, onConnected: show });
    if (status.sessionError) {
      const notice = document.createElement('p');
      notice.className = 'settings-note';
      notice.textContent = status.sessionError;
      resultsView.querySelector('#whodb-sign-in-status').append(notice);
    }
    function destination(value) {
      try {
        const url = new URL(value);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        return !url.username && !url.password && (url.protocol === 'https:' || (loopback && url.protocol === 'http:')) ? url.href : null;
      } catch { return null; }
    }
    function updateLink() {
      const url = destination(field.value.trim());
      link.classList.toggle('hidden', !url);
      if (url) link.href = url;
      else link.removeAttribute('href');
    }
    field.addEventListener('input', updateLink);
    document.querySelector('#save-whodb-instance').onclick = () => {
      const url = destination(field.value.trim());
      if (!url) return notify('Enter an HTTPS instance URL, or an HTTP localhost address.');
      localStorage.setItem('habibi.whodb.instance', url);
      notify('WhoDB instance saved on this Mac');
      show();
    };
    document.querySelector('#connect-whodb-mcp').onclick = async (event) => {
      event.currentTarget.disabled = true;
      const host = field.value.trim() ? destination(field.value.trim()) : '';
      if (field.value.trim() && !host) { event.currentTarget.disabled = false; return notify('Enter a valid HTTPS instance URL.'); }
      try {
        const data = await fetch('/api/whodb/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverId: document.querySelector('#whodb-mcp-server').value, host }) }).then((response) => response.json());
        if (!data.ok) { notify(data.error || 'Could not connect to WhoDB'); return; }
        if (host) localStorage.setItem('habibi.whodb.instance', host);
        show();
      } catch { notify('Could not connect to WhoDB'); }
      finally { const button = document.querySelector('#connect-whodb-mcp'); if (button) button.disabled = false; }
    };
    updateLink();
    refreshIcons();
  }
  function showUnavailable(title, message) {
    setHtml(resultsView, `<div class="workspace-heading"><span><p class="eyebrow">HABIBI · WHODB</p><h2>Your workspace</h2></span><span class="status-pill">${connection.connected ? 'Signed in · read-only' : 'Connection unavailable'}</span></div><section class="whodb-view"><div class="clear-day"><span><b>${escapeHtml(title)}</b><small>${escapeHtml(message)}</small></span></div><div class="whodb-actions"><button class="primary" id="retry-whodb-workspace">Try again</button><button class="secondary" id="manage-whodb-connection">Manage connection</button></div></section>`);
    resultsView.querySelector('#retry-whodb-workspace').onclick = show;
    resultsView.querySelector('#manage-whodb-connection').onclick = () => showSetup(connection);
  }
  async function show() {
    onOpen(); connectedView = null;
    defaultView.classList.add('hidden'); resultsView.classList.remove('hidden');
    count.textContent = 'WhoDB · workspace';
    setHtml(resultsView, `<section class="workspace-loading" role="status" aria-live="polite"><div class="loading-state">${spinner()}<span>Reading your WhoDB connection…</span></div></section>`);
    const marker = resultsView.firstElementChild;
    try {
      connection = await fetch('/api/whodb/status').then((response) => response.json());
      if (!marker.isConnected) return;
      if (!connection.connected) return showSetup(connection);
      const scope = await fetch('/api/whodb/scope').then((response) => response.json());
      if (!marker.isConnected) return;
      if (!scope.ok) {
        if (scope.code === 'WHODB_SIGN_IN_REQUIRED') return showSetup({ ...connection, connected: false, sessionError: 'Your saved session could not be restored. Please sign in again.' });
        return showUnavailable('Your workspaces could not load.', 'Your sign-in is saved. Check your connection and workspace permissions, then try again.');
      }
      if (!scope.org) return showUnavailable('No organizations are available.', 'This account has no accessible organizations. Check your access in WhoDB, then try again.');
      connectedView = showWhoDbConnected({ input, resultsView, count, notify, connection, scope, onSettings: () => showSetup(connection) });
    } catch { if (marker.isConnected) showUnavailable('WhoDB is unavailable.', 'Check your connection, then try again.'); }
  }
  return { show, filter: (query) => connectedView?.filter(query) };
}
