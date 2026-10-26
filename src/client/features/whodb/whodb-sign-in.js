import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml } from '../../core/view-helpers.js';

/** One pending response waits for the browser callback; there is no sign-in polling loop. */
export function installWhoDbSignIn({ container, field, notify, onConnected }) {
  const button = container.querySelector('#sign-in-whodb');
  const target = container.querySelector('#whodb-sign-in-status');
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.json());
  button.onclick = async () => {
    button.disabled = true;
    setHtml(target, '<p class="settings-note">Preparing secure sign-in…</p>');
    try {
      const login = await post('/api/whodb/login', { host: field.value.trim() || 'https://app.whodb.com' });
      if (!login.ok) throw new Error(login.error);
      if (!target.isConnected) { await post('/api/whodb/login/cancel', { id: login.id }); return; }
      const url = new URL(login.url);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Invalid sign-in URL.');
      setHtml(target, `<p class="settings-note">Finish signing in in your browser. <a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">Reopen sign-in</a></p><button id="cancel-whodb-sign-in" class="secondary">Cancel</button>`);
      target.querySelector('#cancel-whodb-sign-in').onclick = () => post('/api/whodb/login/cancel', { id: login.id });
      const opened = await post('/api/whodb/login/open', { id: login.id });
      if (!opened.ok) notify('Use Reopen sign-in to open the login page.');
      const result = await post('/api/whodb/login/wait', { id: login.id });
      if (!result.ok) throw new Error(result.error);
      localStorage.setItem('habibi.whodb.instance', login.host);
      notify('WhoDB connected');
      if (target.isConnected) onConnected();
    } catch {
      if (target.isConnected) setHtml(target, '<p class="settings-note">Sign-in was cancelled, expired, or could not finish. Try again.</p>');
    } finally { button.disabled = false; }
  };
}
