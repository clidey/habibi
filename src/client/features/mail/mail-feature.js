import { renderFailure } from '../../core/failure-view.js';
import { setHtml } from '../../core/safe-dom.js';
import { approvalNotice, escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';

/** Owns mail account setup, inbox search, threads, compose, and send approval. */
export function createMailFeature({ input, defaultView, resultsView, count, notify, requestApproval, onHome, onOpen, onPreview }) {
  let inboxState = null;
  let searchTimer = null;
  let searchSequence = 0;

function mailThreadListMarkup(threads, connected, emptyCopy = 'No messages matched that search.') {
  return threads.length ? `<div class="result-list mail-thread-list">${threads.map((thread, index) => `<button class="result ${index === 0 ? 'selected' : ''}" data-mail-thread="${thread.id}" data-mail-provider="${thread.accountId}"><span class="icon gmail">${icon('mail')}</span><span class="result-copy"><span class="result-title">${escapeHtml(thread.subject)}</span><span class="result-meta">${escapeHtml(thread.from || 'Unknown sender')} · ${escapeHtml(thread.label || connected.find(account => account.id === thread.accountId)?.label || 'Mail')} · ${escapeHtml(thread.accountEmail || '')}</span></span><span class="chat-end"><time>${thread.timestamp ? new Date(thread.timestamp).toLocaleDateString([], { month:'short', day:'numeric' }) : ''}</time>${thread.unread ? `<span class="unread-mail" title="Unread email" aria-label="Unread email">${icon('mail')}</span>` : ''}</span></button>`).join('')}</div>` : `<div class="clear-day"><span class="icon gmail">${icon('inbox')}</span><span><b>${escapeHtml(emptyCopy)}</b><small>Try a sender, subject, phrase, or a natural-language request.</small></span></div>`;
}
function bindMailThreads(target) {
  target.querySelectorAll('[data-mail-thread]').forEach(button => button.onclick = () => showMailThread(button.dataset.mailThread, button.dataset.mailProvider));
  refreshIcons();
}
function renderMailInbox(threads, connected) {
  if (!inboxState?.target?.isConnected) return;
  setHtml(inboxState.target, mailThreadListMarkup(threads, connected, 'Your inbox is empty.'));
  bindMailThreads(inboxState.target);
}
function searchMailInbox(query) {
  const state = inboxState;
  if (!state?.target?.isConnected) return;
  clearTimeout(searchTimer);
  const trimmed = query.trim();
  if (!trimmed) {
    document.querySelector('#mail-status-copy').textContent = state.status;
    count.textContent = `${state.threads.length} messages`;
    renderMailInbox(state.threads, state.connected);
    return;
  }
  const sequence = ++searchSequence;
  searchTimer = setTimeout(async () => {
    if (!inboxState?.target?.isConnected || sequence !== searchSequence) return;
    setHtml(state.target, '<div class="loading-state"><span class="spinner"></span> Searching your connected inboxes…</div>');
    count.textContent = 'Searching mail…';
    try {
      const response = await fetch(`/api/mail/search?q=${encodeURIComponent(trimmed)}&provider=all`);
      const data = await response.json();
      if (sequence !== searchSequence || !inboxState?.target?.isConnected) return;
      if (!data.ok) throw new Error(data.error || 'Could not search mail.');
      const plan = data.plan || {};
      const planner = plan.source === 'local-model' ? 'local model' : 'local matching';
      document.querySelector('#mail-status-copy').textContent = `Search results · ${planner}`;
      count.textContent = `${(data.threads || []).length} matching messages`;
      setHtml(state.target, mailThreadListMarkup(data.threads || [], state.connected));
      bindMailThreads(state.target);
    } catch (error) {
      if (sequence !== searchSequence || !inboxState?.target?.isConnected) return;
      renderFailure(state.target, error, { fallback:'Could not search mail.', retry:() => searchMailInbox(trimmed) });
    }
  }, 260);
}
function showMailClient({ compose = false } = {}) {
  onOpen();
  clearTimeout(searchTimer); searchSequence += 1; inboxState = null;
  input.value = ''; input.placeholder = 'Search mail by sender, subject, or request…';
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = 'Mail · checking accounts…';
  // Decide onboarding vs. inbox before the first paint — a fully-wired
  // composer shell that gets replaced by onboarding a moment later (once
  // /api/mail/status resolves) is the same jarring reset WhatsApp had.
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-mail">${icon('arrow-left')} Habibi</button><span class="verified">● checking accounts</span></div><div class="loading-state"><span class="spinner"></span> Checking connected mail accounts…</div>`);
  document.querySelector('#back-mail').onclick = onHome;
  fetch('/api/mail/status').then(response => response.json()).then(data => {
    if (!data.ok) throw new Error('Mail unavailable');
    const providers = data.providers || [];
    const connected = (data.accounts || []).filter(account => account.connected);
    if (!connected.length) {
      setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-mail">${icon('arrow-left')} Habibi</button><span class="verified">● private mail</span></div><section class="mail-onboarding"><div class="openwa-intro"><span class="icon gmail">${icon('mail')}</span><span><h2>Connect your mail</h2><p>Read threads and reply from Habibi. Your inbox stays with the provider; ${approvalNotice('sending')}</p></span></div><div class="provider-options mail-provider-options">${providers.map(provider => `<button class="provider-option" data-mail-provider="${provider.id}"><span><b>${icon('mail')} ${provider.label}</b><small>${provider.configured ? 'Continue with your configured OAuth app' : 'Set up your OAuth app to connect'}</small></span><em>${provider.configured ? 'CONNECT' : 'SET UP'}</em><i>${icon('chevron-right')}</i></button>`).join('')}</div></section>`);
      document.querySelector('#back-mail').onclick = onHome;
      resultsView.querySelectorAll('[data-mail-provider]').forEach(button => button.onclick = () => showMailProviderSetup(button.dataset.mailProvider));
      refreshIcons();
      return;
    }
    const status = connected.map(account => `${account.label} · ${account.email}`).join(' + ');
    count.textContent = 'Mail · loading inbox…';
    setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-mail">${icon('arrow-left')} Habibi</button><span class="verified">● private mail client</span></div><section class="chat-client mail-client"><div class="chat-title"><span class="icon gmail">${icon('mail')}</span><span><b>Mail</b><small id="mail-status-copy">${escapeHtml(status)}</small></span><button class="history-button" id="manage-mail">Manage accounts</button></div><div class="messages mail-empty" id="mail-accounts"><div class="loading-state"><span class="spinner"></span> Loading your inbox…</div></div></section>`);
    document.querySelector('#back-mail').onclick = onHome;
    document.querySelector('#manage-mail').onclick = showMailSettings;
    const target = document.querySelector('#mail-accounts');
    // Load each account independently: one account whose saved credentials
    // stopped working should not blank the whole inbox for accounts that are
    // still fine, and knowing exactly which account failed is what lets the
    // "Reconnect {email}" affordance below point at the right one.
    Promise.all(connected.map(account => fetch(`/api/mail/threads?provider=${encodeURIComponent(account.id)}`).then(response => response.json()).then(inbox => ({ account, inbox })).catch(() => ({ account, inbox:{ ok:false } }))))
      .then(results => {
        const threads = results.filter(({ inbox }) => inbox.ok).flatMap(({ inbox }) => inbox.threads).sort((a, b) => b.timestamp - a.timestamp);
        const failed = results.filter(({ inbox }) => !inbox.ok).map(({ account }) => account);
        inboxState = { target, connected, threads, status };
        count.textContent = `${threads.length} messages`;
        const reconnectBanner = failed.length ? `<div class="link-warning mail-reconnect-banner">${failed.map(account => `${escapeHtml(account.label)} · ${escapeHtml(account.email)} stopped working. <button type="button" class="link-button" data-mail-reconnect="${escapeHtml(account.id)}">Reconnect</button>`).join('<br>')}</div>` : '';
        if (!inboxState?.target?.isConnected) return;
        setHtml(target, reconnectBanner + mailThreadListMarkup(threads, connected));
        bindMailThreads(target);
        target.querySelectorAll('[data-mail-reconnect]').forEach(button => button.onclick = () => {
          const account = failed.find(candidate => candidate.id === button.dataset.mailReconnect);
          if (account) showMailProviderSetup(account.provider, account);
        });
        refreshIcons();
      }).catch(error => { renderFailure(target, error, { fallback:'Could not load your inbox.', retry:() => showMailClient({ compose }) }); });
  }).catch(() => { setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-mail">${icon('arrow-left')} Habibi</button><span class="verified">● unavailable</span></div><div class="local-files-empty">Mail connection status is unavailable.</div>`); document.querySelector('#back-mail').onclick = onHome; });
  refreshIcons();
}
function showMailThread(threadId, provider) {
  onOpen('mail-thread');
  inboxState = null;
  // This route is also opened directly from the Home briefing. Make the
  // transition explicit instead of relying on the Mail inbox having already
  // revealed the results surface.
  defaultView.classList.add('hidden');
  resultsView.classList.remove('hidden');
  input.value = '';
  input.placeholder = 'Search mail by sender, subject, or request…';
  const providerLabel = provider === 'zoho' ? 'Zoho Mail' : provider === 'gmail' ? 'Gmail' : 'Mail';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-mail-thread">${icon('arrow-left')} Mail</button><span class="verified">● ${escapeHtml(provider || 'mail')}</span></div><section class="chat-client mail-thread-client"><div class="chat-title"><span class="icon gmail">${icon('mail')}</span><span><b>Loading email…</b><small>Reading from your connected account</small></span></div><div class="messages"><div class="loading-state"><span class="spinner"></span> Loading message…</div></div><div class="chat-composer"><textarea rows="2" placeholder="Reply support is coming next…" disabled></textarea><div><span>${approvalNotice('Sending')}</span><span class="composer-actions"><button class="secondary" id="open-mail-provider">Open in ${providerLabel} <kbd>⌘ ↵</kbd></button><button class="primary" disabled>Reply</button></span></div></div></section>`);
  document.querySelector('#back-mail-thread').onclick = showMailClient;
  fetch(`/api/mail/message?provider=${encodeURIComponent(provider)}&uid=${encodeURIComponent(threadId)}`).then(response => response.json()).then(data => {
    if (!data.ok) throw new Error(data.error);
    const message = data.message; const box = document.querySelector('.mail-thread-client .messages');
    document.querySelector('.mail-thread-client .chat-title b').textContent = message.subject;
    document.querySelector('.mail-thread-client .chat-title small').textContent = `${message.from} · ${message.accountEmail || ''}`;
    const actualProvider = message.provider || provider;
    const actualProviderLabel = actualProvider === 'zoho' ? 'Zoho Mail' : actualProvider === 'gmail' ? 'Gmail' : 'Mail';
    setHtml(document.querySelector('#open-mail-provider'), `Open in ${actualProviderLabel} <kbd>⌘ ↵</kbd>`);
    const attachmentMarkup = message.attachments?.length ? `<div class="mail-message-attachments">${message.attachments.map(attachment => `<span>${icon('paperclip')} ${escapeHtml(attachment.filename)} · ${Math.max(1, Math.round(attachment.size / 1024))} KB</span>`).join('')}</div>` : '';
    const formatMailBody = value => escapeHtml(value).split(/\n{2,}/).map(part => `<p>${part.replace(/\n/g, '<br>')}</p>`).join('');
    const senderName = value => String(value || 'Unknown sender').replace(/\s*<[^>]+>\s*$/, '').replace(/^"|"$/g, '');
    const messageTime = (part, index) => {
      const value = part.timestamp || Date.parse(part.sent || '') || (index === 0 ? message.timestamp : 0);
      return value ? new Date(value).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '';
    };
    const forwardMarker = part => part.forwardedFrom ? `<div class="forwarded-message"><span class="forwarded-icon">${icon('forward')}</span><span><b>Forwarded message</b><small>From ${escapeHtml(senderName(part.forwardedFrom))}${part.forwardedFrom.match(/<([^>]+)>/)?.[1] ? ` · ${escapeHtml(part.forwardedFrom.match(/<([^>]+)>/)?.[1])}` : ''}</small>${part.forwardedTo ? `<small>Forwarded to ${escapeHtml(part.forwardedTo)}</small>` : ''}</span></div>` : '';
    setHtml(box, (message.messages || []).map((part, index) => `<article class="message ${part.direction === 'outgoing' ? 'outgoing' : 'incoming'} mail-message"><header class="mail-message-header"><span class="mail-sender">${escapeHtml(senderName(part.from))}</span>${part.from && senderName(part.from) !== part.from ? `<span class="mail-address">${escapeHtml(part.from.match(/<([^>]+)>/)?.[1] || '')}</span>` : ''}</header><div class="mail-body ${part.html ? 'mail-html' : ''}">${part.html || formatMailBody(part.body)}</div>${forwardMarker(part)}${index === 0 ? attachmentMarkup : ''}<time>${escapeHtml(messageTime(part, index))}</time></article>`).join('') || '<div class="local-files-empty">No readable message content.</div>');
    const openProvider = async () => {
      const button = document.querySelector('#open-mail-provider');
      if (button?.disabled) return;
      button.disabled = true;
      const result = await fetch('/api/mail/open', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ provider:message.accountId || provider, subject:message.subject, messageId:message.messageId }) }).then(response => response.json()).catch(() => ({ ok:false }));
      button.disabled = false;
      if (!result.ok) return notify('Could not open your mail provider.');
      notify(actualProvider === 'zoho' ? 'Opened Zoho Mail' : 'Opened this email in Gmail');
    };
    document.querySelector('#open-mail-provider').onclick = openProvider;
    document.querySelector('#open-mail-provider').dataset.mailOpen = 'true';
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }).catch(error => { const box = document.querySelector('.mail-thread-client .messages'); renderFailure(box, error, { fallback:'Could not load this message.', retry:() => showMailThread(threadId, provider) }); });
  refreshIcons();
}
function showMailSettings({ onBack = showMailClient } = {}) {
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-mail-settings">${icon('arrow-left')} Mail</button><span class="verified">● local settings</span></div><section class="provider-setup"><div class="chat-title"><span class="icon gmail">${icon('settings')}</span><span><b>Mail accounts</b><small>Connections and credentials stay on this Mac.</small></span></div><div id="mail-settings-list" class="provider-options"><div class="loading-state"><span class="spinner"></span> Loading accounts…</div></div></section>`);
  document.querySelector('#back-mail-settings').onclick = onBack;
  fetch('/api/mail/status').then(response => response.json()).then(data => {
    const list = document.querySelector('#mail-settings-list');
    const accounts = data.accounts || [];
    setHtml(list, `${accounts.map(account => `<div class="provider-option"><span><b>${escapeHtml(account.label)} · ${escapeHtml(account.email)}</b><small>Connected via ${escapeHtml(account.transport || 'IMAP')}</small></span><span class="mail-settings-actions"><button class="secondary" data-reconnect="${account.provider}">Add another</button><button class="secondary" data-remove-mail="${escapeHtml(account.id)}">Remove</button></span></div>`).join('')}<div class="provider-option"><span><b>Add mail account</b><small>Connect another Gmail or Zoho Mail inbox.</small></span><span class="mail-settings-actions">${(data.providers || []).map(provider => `<button class="secondary" data-reconnect="${provider.id}">${provider.label}</button>`).join('')}</span></div>`);
    list.querySelectorAll('[data-reconnect]').forEach(button => button.onclick = () => showMailProviderSetup(button.dataset.reconnect));
    list.querySelectorAll('[data-remove-mail]').forEach(button => button.onclick = async () => { button.disabled = true; const result = await fetch('/api/mail/remove', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ provider:button.dataset.removeMail }) }).then(response => response.json()); if (!result.ok) return notify(result.error || 'Could not remove account'); notify('Mail account removed'); showMailSettings(); });
  }).catch(() => { const list = document.querySelector('#mail-settings-list'); if (list) list.textContent = 'Mail settings are unavailable.'; });
  refreshIcons();
}
function showMailProviderSetup(provider, existingAccount) {
  const label = provider === 'zoho' ? 'Zoho Mail' : 'Gmail';
  const host = provider === 'gmail' ? 'imap.gmail.com' : 'imappro.zoho.com';
  // An account that already exists but stopped authenticating gets its email
  // pre-filled and different framing — asking someone to re-type an address
  // Habibi already has on file, as if it were a brand-new connection, is a
  // needless extra step and reads as if the previous setup was forgotten.
  const heading = existingAccount ? `Reconnect ${label}` : `Connect ${label}`;
  const subtitle = existingAccount ? `${existingAccount.email} stopped authenticating. Enter a fresh app password to reconnect it.` : 'Use a provider app password. It stays in macOS Keychain.';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-mail-setup">${icon('arrow-left')} Mail</button><span class="verified">● IMAP setup</span></div><section class="provider-setup"><div class="chat-title"><span class="icon gmail">${icon('mail')}</span><span><b>${escapeHtml(heading)}</b><small>${escapeHtml(subtitle)}</small></span></div><div class="provider-detail"><div class="provider-fields"><label>Email address<input id="mail-email" type="email" autocomplete="email" value="${escapeHtml(existingAccount?.email || '')}" ${existingAccount ? 'readonly' : ''} /></label><label>App password<input id="mail-app-password" type="password" autocomplete="off" /></label><label>IMAP server<input id="mail-imap-host" value="${host}" autocomplete="off" /></label></div><div class="provider-actions"><span>IMAP uses SSL on port 993.</span><button class="primary" id="connect-mail-provider">${existingAccount ? 'Reconnect' : 'Connect'} <kbd>↵</kbd></button></div></div></section>`);
  document.querySelector('#back-mail-setup').onclick = showMailClient;
  document.querySelector('#connect-mail-provider').onclick = async () => {
    const response = await fetch('/api/mail/imap', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ provider, email:document.querySelector('#mail-email').value, password:document.querySelector('#mail-app-password').value, host:document.querySelector('#mail-imap-host').value }) });
    const configured = await response.json();
    if (!configured.ok) return notify(configured.error || 'Could not save mail configuration');
    notify(`${label} connected`); showMailClient();
  };
  refreshIcons();
}
function showEmailComposer(subject, attachment) {
  // Drop-to-compose and the ⌘N shortcut can reach this before the Mail client
  // has ever loaded account status, so fetch it rather than assume it's cached.
  if (!inboxState?.connected) {
    fetch('/api/mail/status').then(response => response.json()).then(data => {
      inboxState = { connected:(data.accounts || []).filter(account => account.connected) };
      renderEmailComposer(subject, attachment);
    }).catch(() => { inboxState = { connected:[] }; renderEmailComposer(subject, attachment); });
    return;
  }
  renderEmailComposer(subject, attachment);
}
function renderEmailComposer(subject, attachment) {
  const connected = inboxState?.connected || [];
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = connected.length ? `${connected[0].label} · draft` : 'Mail · draft';
  const accountOptions = connected.map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.label)} · ${escapeHtml(account.email)}</option>`).join('');
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-email-compose">${icon('arrow-left')} Mail</button><span class="verified">● draft stays local</span></div>
    <section class="mail-compose">${connected.length > 1 ? `<div class="mail-line"><span>From</span><select id="mail-from">${accountOptions}</select></div>` : ''}<div class="mail-line"><span>To</span><input id="mail-to" type="email" placeholder="Recipient" aria-label="Email recipient" /></div><div class="mail-line"><span>Subject</span><input id="mail-subject" value="${escapeHtml(subject === 'Gmail' ? '' : subject && subject !== 'New email' ? `Re: ${subject}` : '')}" aria-label="Email subject" /></div><textarea id="mail-body" class="mail-body" placeholder="Write a message…"></textarea><div id="attachment-zone" class="attachment-zone"><span class="icon files">${icon('paperclip')}</span><span><b>Drop a local file here</b><small>It will be attached to this draft</small></span></div><div class="attachment-list"></div><div class="mail-actions"><span>${connected.length ? approvalNotice('Sending') : 'Connect a mail account first'}</span><button class="primary" id="send-email"${connected.length ? '' : ' disabled'}>Send email <kbd>⌘ ↵</kbd></button></div></section>`);
  document.querySelector('#back-email-compose').onclick = showMailClient;
  if (attachment) addAttachment(attachment);
  const zone = document.querySelector('#attachment-zone');
  zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', event => { event.preventDefault(); zone.classList.remove('drag-over'); const path = event.dataTransfer.getData('application/x-habibi-file'); if (path) addAttachment({ path, name: event.dataTransfer.getData('application/x-habibi-name') }); });
  const sendButton = document.querySelector('#send-email');
  const send = async () => {
    if (sendButton.disabled) return;
    const provider = connected.length > 1 ? document.querySelector('#mail-from').value : connected[0]?.id;
    const to = document.querySelector('#mail-to').value.trim();
    const subjectValue = document.querySelector('#mail-subject').value.trim();
    const body = document.querySelector('#mail-body').value.trim();
    if (!provider) return notify('Connect a mail account first');
    if (!to) return notify('Enter a recipient');
    if (!body) return notify('Write a message first');
    sendButton.disabled = true; const originalLabel = sendButton.innerHTML; setHtml(sendButton, '<span class="mini-spinner"></span> Sending');
    try {
      const approvalToken = await requestApproval('mail.send', { provider, to, subject:subjectValue, body });
      const result = await fetch('/api/mail/send', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ provider, to, subject:subjectValue, body, approvalToken }) }).then(response => response.json());
      if (!result.ok) throw new Error(result.error || 'Could not send this email.');
      notify('Email sent'); showMailClient();
    } catch (error) {
      sendButton.disabled = false; setHtml(sendButton, originalLabel);
      notify(error.message || 'Could not send this email.');
    }
  };
  sendButton.onclick = send;
  resultsView.querySelector('.mail-compose').addEventListener('keydown', event => { if (event.metaKey && event.key === 'Enter') { event.preventDefault(); send(); } });
  refreshIcons();
}
function addAttachment(file) {
  const list = document.querySelector('.attachment-list');
  if (!list || list.dataset.path === file.path) return;
  list.dataset.path = file.path;
  const isPdf = /\.pdf$/i.test(file.name);
  setHtml(list, `<div class="attachment"><span class="icon ${isPdf ? 'pdf' : 'files'}">${icon(isPdf ? 'file-text' : 'file')}</span><span><b>${escapeHtml(file.name)}</b><small>Local file · attached to draft</small></span><button aria-label="Remove attachment">${icon('x')}</button></div>`);
  list.querySelector('button').onclick = () => { list.innerHTML=''; list.dataset.path=''; };
  refreshIcons();
}

  return { search:searchMailInbox, showClient:showMailClient, showComposer:showEmailComposer, showProviderSetup:showMailProviderSetup, showSettings:showMailSettings, showThread:showMailThread };
}
