import { setHtml } from '../../core/safe-dom.js';
import { nativeDaily } from '../../core/native-daily.js';
import { escapeHtml, icon, refreshIcons, spinner } from '../../core/view-helpers.js';

const caldavPresets = {
  icloud: {
    label: 'iCloud',
    serverUrl: 'https://caldav.icloud.com/',
    user: 'Apple Account email',
    note: 'Use an app-specific password from account.apple.com. iCloud Reminders lists upgraded since iOS 13 are not available over CalDAV, so only your calendars (and any older lists) appear.',
  },
  fastmail: {
    label: 'Fastmail',
    serverUrl: 'https://caldav.fastmail.com/dav/',
    user: 'Fastmail address',
    note: 'Create an app password with calendar (CalDAV) access in Fastmail → Settings → Privacy & Security.',
  },
  nextcloud: {
    label: 'Nextcloud',
    serverUrl: '',
    placeholder: 'https://cloud.example.com/remote.php/dav',
    user: 'User name',
    note: 'Create an app password in Nextcloud → Personal settings → Security.',
  },
  other: {
    label: 'CalDAV',
    serverUrl: '',
    placeholder: 'https://dav.example.com/',
    user: 'User name',
    note: 'Enter your server’s CalDAV address and an app password.',
  },
};
const accessCopy = {
  fullAccess: 'Allowed',
  writeOnly: 'Add only',
  notDetermined: 'Not allowed yet',
  denied: 'Off in System Settings',
};

const post = (path, body) =>
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((response) => response.json());

/** Connect and remove Google, CalDAV and (on macOS) system calendar sources. */
export function createCalendarAccounts({ defaultView, resultsView, count, notify, onOpen, requestCalendarAccess, showUpcoming }) {
  let back = () => {};
  function frame(title, subtitle, body, label = 'Calendar') {
    onOpen();
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = 'Calendar · accounts';
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-calendar-accounts">${icon('arrow-left')} ${escapeHtml(label)}</button><span class="verified">● credentials stay in your system keychain</span></div><section class="provider-setup"><div class="chat-title"><span class="icon calendar">${icon('calendar-days')}</span><span><b>${escapeHtml(title)}</b><small>${escapeHtml(subtitle)}</small></span></div>${body}</section>`,
    );
    refreshIcons();
  }
  async function show({ onBack } = {}) {
    if (onBack) back = onBack;
    frame('Calendar accounts', 'Events and reminders from every connected account.', `<div id="calendar-accounts-list" class="provider-options"><div class="loading-state">${spinner()} Loading accounts…</div></div>`, 'Back');
    document.querySelector('#back-calendar-accounts').onclick = () => back();
    const data = await fetch('/api/calendar/accounts').then((response) => response.json()).catch(() => ({ ok: false }));
    const list = document.querySelector('#calendar-accounts-list');
    if (!list) return;
    if (!data.ok) return (list.textContent = 'Calendar accounts are unavailable.');
    const system = data.system
      ? `<div class="provider-option"><span><b>${escapeHtml(data.system.label)} · Calendar &amp; Reminders</b><small>Calendar: ${escapeHtml(accessCopy[data.system.calendar] || '')} · Reminders: ${escapeHtml(accessCopy[data.system.reminders] || '')}</small></span><span class="mail-settings-actions">${data.system.calendar !== 'fullAccess' ? '<button class="secondary" data-system-access="calendar">Allow Calendar</button>' : ''}${data.system.reminders !== 'fullAccess' ? '<button class="secondary" data-system-access="reminders">Allow Reminders</button>' : ''}</span></div>`
      : '';
    const accounts = (data.accounts || [])
      .map(
        (account) =>
          `<div class="provider-option"><span><b>${escapeHtml(account.label)} · ${escapeHtml(account.detail)}</b><small>${account.connected ? 'Calendars and reminders' : 'Needs to be reconnected'}</small></span><span class="mail-settings-actions">${account.connected ? '' : `<button class="secondary" data-reconnect-calendar="${escapeHtml(account.kind)}">Reconnect</button>`}<button class="secondary" data-remove-calendar="${escapeHtml(account.id)}">Remove</button></span></div>`,
      )
      .join('');
    const add = `<div class="provider-option"><span><b>Add an account</b><small>Google Calendar and Tasks, or any CalDAV server.</small></span><span class="mail-settings-actions"><button class="secondary" data-add-calendar="google">Google</button>${Object.entries(caldavPresets).map(([id, preset]) => `<button class="secondary" data-add-calendar="${id}">${escapeHtml(preset.label === 'CalDAV' ? 'Other CalDAV' : preset.label)}</button>`).join('')}</span></div>`;
    const upcoming = '<div class="provider-option"><span><b>Upcoming events</b><small>The next 14 days from every account.</small></span><span class="mail-settings-actions"><button class="secondary" id="calendar-accounts-upcoming">View</button></span></div>';
    setHtml(list, system + accounts + add + upcoming);
    list.querySelector('#calendar-accounts-upcoming').onclick = () => showUpcoming({ onBack: () => show() });
    list.querySelectorAll('[data-system-access]').forEach(
      (button) =>
        (button.onclick = async () => {
          button.disabled = true;
          if (button.dataset.systemAccess === 'calendar') return requestCalendarAccess({ onDone: () => show() });
          await nativeDaily('reminders.access').catch((error) => notify(error.message));
          show();
        }),
    );
    list.querySelectorAll('[data-add-calendar], [data-reconnect-calendar]').forEach(
      (button) =>
        (button.onclick = () => {
          const kind = button.dataset.addCalendar || button.dataset.reconnectCalendar;
          if (kind === 'google') return showGoogle(data.mailGoogleClient);
          showCalDav(caldavPresets[kind] || caldavPresets.other);
        }),
    );
    list.querySelectorAll('[data-remove-calendar]').forEach(
      (button) =>
        (button.onclick = async () => {
          button.disabled = true;
          const result = await post('/api/calendar/accounts/remove', { id: button.dataset.removeCalendar }).catch(() => ({}));
          notify(result.ok ? 'Calendar account removed' : result.error || 'Could not remove this account');
          show();
        }),
    );
  }
  function showGoogle(mailClient) {
    frame(
      'Connect Google Calendar',
      'Uses your own OAuth client, like Gmail in Mail. Tokens stay in your system keychain.',
      `<div class="provider-detail"><p class="settings-note">In Google Cloud Console, create an OAuth client of type “Desktop app” and enable the Google Calendar API and Google Tasks API for its project.</p>${mailClient ? '<div class="provider-actions"><span>Reuse the Gmail OAuth client you set up for Mail. Its project needs the Calendar and Tasks APIs enabled, and it must be a Desktop app client.</span><button class="secondary" id="google-use-mail">Use Mail’s client</button></div>' : ''}<div class="provider-fields"><label>Client ID<input id="google-client-id" autocomplete="off" placeholder="…apps.googleusercontent.com" /></label><label>Client secret<input id="google-client-secret" type="password" autocomplete="off" /></label></div><div class="provider-actions" id="google-status"><span>Your browser opens Google’s consent screen.</span><button class="primary" id="google-sign-in">Sign in with Google</button></div></div>`,
    );
    document.querySelector('#back-calendar-accounts').onclick = () => show();
    const start = async (body) => {
      const result = await post('/api/calendar/accounts/google', body).catch(() => ({}));
      if (!result.ok) return notify(result.error || 'Could not start the Google sign-in');
      const status = document.querySelector('#google-status');
      setHtml(status, `<span>${spinner()} Waiting for Google… Finish signing in in your browser.</span><button class="secondary" id="google-cancel">Cancel</button>`);
      if (!result.opened) status.insertAdjacentText('beforebegin', `Open this link to continue: ${result.url}`);
      status.querySelector('#google-cancel').onclick = () => post('/api/calendar/accounts/google/cancel', { flow: result.flow });
      for (let attempt = 0; attempt < 400 && status.isConnected; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const state = await fetch(`/api/calendar/accounts/google/status?flow=${encodeURIComponent(result.flow)}`).then((response) => response.json()).catch(() => ({ ok: true, status: 'pending' }));
        if (state.ok && state.status === 'pending') continue;
        if (state.status === 'connected') notify(`Connected ${state.account?.detail || 'Google'}`);
        else notify(state.error || 'Google sign-in did not finish');
        return status.isConnected ? (state.status === 'connected' ? show() : showGoogle(mailClient)) : undefined;
      }
    };
    document.querySelector('#google-use-mail')?.addEventListener('click', () => start({ useMailClient: true }));
    document.querySelector('#google-sign-in').onclick = () =>
      start({
        clientId: document.querySelector('#google-client-id').value,
        clientSecret: document.querySelector('#google-client-secret').value,
      });
  }
  function showCalDav(preset) {
    frame(
      `Connect ${preset.label}`,
      'CalDAV with an app password. It stays in your system keychain.',
      `<div class="provider-detail"><p class="settings-note">${escapeHtml(preset.note)}</p><div class="provider-fields"><label>Server address<input id="caldav-url" autocomplete="off" value="${escapeHtml(preset.serverUrl)}" placeholder="${escapeHtml(preset.placeholder || '')}" /></label><label>${escapeHtml(preset.user)}<input id="caldav-user" autocomplete="username" /></label><label>App password<input id="caldav-password" type="password" autocomplete="off" /></label></div><div class="provider-actions"><span>Habibi finds your calendars and task lists.</span><button class="primary" id="caldav-connect">Connect <kbd>↵</kbd></button></div></div>`,
    );
    document.querySelector('#back-calendar-accounts').onclick = () => show();
    const button = document.querySelector('#caldav-connect');
    button.onclick = async () => {
      button.disabled = true;
      const result = await post('/api/calendar/accounts/caldav', {
        label: preset.label === 'CalDAV' ? '' : preset.label,
        serverUrl: document.querySelector('#caldav-url').value,
        username: document.querySelector('#caldav-user').value,
        password: document.querySelector('#caldav-password').value,
      }).catch(() => ({}));
      button.disabled = false;
      if (!result.ok) return notify(result.error || 'Could not connect this account');
      notify(`${preset.label} connected · ${result.calendars} calendars, ${result.lists} task lists`);
      show();
    };
  }
  return { show };
}
