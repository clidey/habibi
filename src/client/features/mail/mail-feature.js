import { renderFailure } from '../../core/failure-view.js';
import { setHtml } from '../../core/safe-dom.js';
import { approvalNotice, escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';
import { createMailComposer } from './mail-composer.js';
import { createMailInbox } from './mail-inbox.js';

/** Owns mail account setup, inbox search, threads, compose, and send approval. */
export function createMailFeature({
  input,
  defaultView,
  resultsView,
  count,
  notify,
  requestApproval,
  onHome,
  onOpen,
  onPreview,
}) {
  let inbox;
  function showMailClient(options) {
    return inbox.show(options);
  }
  function showMailThread(threadId, provider) {
    onOpen('mail-thread');
    // This route is also opened directly from the Home briefing. Make the
    // transition explicit instead of relying on the Mail inbox having already
    // revealed the results surface.
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    input.value = '';
    input.placeholder = 'Search mail by sender, subject, or request…';
    const providerLabel =
      provider === 'zoho' ? 'Zoho Mail' : provider === 'gmail' ? 'Gmail' : 'Mail';
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-mail-thread">${icon('arrow-left')} Mail</button><span class="verified">● ${escapeHtml(provider || 'mail')}</span></div><section class="chat-client mail-thread-client"><div class="chat-title"><span class="icon gmail">${icon('mail')}</span><span><b>Loading email…</b><small>Reading from your connected account</small></span></div><div class="messages"><div class="loading-state"><span class="spinner"></span> Loading message…</div></div><div class="chat-composer"><textarea rows="2" placeholder="Reply support is coming next…" disabled></textarea><div><span>${approvalNotice('Sending')}</span><span class="composer-actions"><button class="secondary" id="open-mail-provider">Open in ${providerLabel} <kbd>⌘ ↵</kbd></button><button class="primary" disabled>Reply</button></span></div></div></section>`,
    );
    document.querySelector('#back-mail-thread').onclick = showMailClient;
    fetch(
      `/api/mail/message?provider=${encodeURIComponent(provider)}&uid=${encodeURIComponent(threadId)}`,
    )
      .then((response) => response.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error);
        const message = data.message;
        const box = document.querySelector('.mail-thread-client .messages');
        document.querySelector('.mail-thread-client .chat-title b').textContent = message.subject;
        document.querySelector('.mail-thread-client .chat-title small').textContent =
          `${message.from} · ${message.accountEmail || ''}`;
        const actualProvider = message.provider || provider;
        const actualProviderLabel =
          actualProvider === 'zoho' ? 'Zoho Mail' : actualProvider === 'gmail' ? 'Gmail' : 'Mail';
        setHtml(
          document.querySelector('#open-mail-provider'),
          `Open in ${actualProviderLabel} <kbd>⌘ ↵</kbd>`,
        );
        const attachmentMarkup = message.attachments?.length
          ? `<div class="mail-message-attachments">${message.attachments.map((attachment) => `<span>${icon('paperclip')} ${escapeHtml(attachment.filename)} · ${Math.max(1, Math.round(attachment.size / 1024))} KB</span>`).join('')}</div>`
          : '';
        const formatMailBody = (value) =>
          escapeHtml(value)
            .split(/\n{2,}/)
            .map((part) => `<p>${part.replace(/\n/g, '<br>')}</p>`)
            .join('');
        const senderName = (value) =>
          String(value || 'Unknown sender')
            .replace(/\s*<[^>]+>\s*$/, '')
            .replace(/^"|"$/g, '');
        const messageTime = (part, index) => {
          const value =
            part.timestamp || Date.parse(part.sent || '') || (index === 0 ? message.timestamp : 0);
          return value
            ? new Date(value).toLocaleString([], {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })
            : '';
        };
        const forwardMarker = (part) =>
          part.forwardedFrom
            ? `<div class="forwarded-message"><span class="forwarded-icon">${icon('forward')}</span><span><b>Forwarded message</b><small>From ${escapeHtml(senderName(part.forwardedFrom))}${part.forwardedFrom.match(/<([^>]+)>/)?.[1] ? ` · ${escapeHtml(part.forwardedFrom.match(/<([^>]+)>/)?.[1])}` : ''}</small>${part.forwardedTo ? `<small>Forwarded to ${escapeHtml(part.forwardedTo)}</small>` : ''}</span></div>`
            : '';
        setHtml(
          box,
          (message.messages || [])
            .map(
              (part, index) =>
                `<article class="message ${part.direction === 'outgoing' ? 'outgoing' : 'incoming'} mail-message"><header class="mail-message-header"><span class="mail-sender">${escapeHtml(senderName(part.from))}</span>${part.from && senderName(part.from) !== part.from ? `<span class="mail-address">${escapeHtml(part.from.match(/<([^>]+)>/)?.[1] || '')}</span>` : ''}</header><div class="mail-body ${part.html ? 'mail-html' : ''}">${part.html || formatMailBody(part.body)}</div>${forwardMarker(part)}${index === 0 ? attachmentMarkup : ''}<time>${escapeHtml(messageTime(part, index))}</time></article>`,
            )
            .join('') || '<div class="local-files-empty">No readable message content.</div>',
        );
        const openProvider = async () => {
          const button = document.querySelector('#open-mail-provider');
          if (button?.disabled) return;
          button.disabled = true;
          const result = await fetch('/api/mail/open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider: message.accountId || provider,
              subject: message.subject,
              messageId: message.messageId,
            }),
          })
            .then((response) => response.json())
            .catch(() => ({ ok: false }));
          button.disabled = false;
          if (!result.ok) return notify('Could not open your mail provider.');
          notify(actualProvider === 'zoho' ? 'Opened Zoho Mail' : 'Opened this email in Gmail');
        };
        document.querySelector('#open-mail-provider').onclick = openProvider;
        document.querySelector('#open-mail-provider').dataset.mailOpen = 'true';
        requestAnimationFrame(() => {
          box.scrollTop = box.scrollHeight;
        });
      })
      .catch((error) => {
        const box = document.querySelector('.mail-thread-client .messages');
        renderFailure(box, error, {
          fallback: 'Could not load this message.',
          retry: () => showMailThread(threadId, provider),
        });
      });
    refreshIcons();
  }
  function showMailSettings({ onBack = showMailClient } = {}) {
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-mail-settings">${icon('arrow-left')} Mail</button><span class="verified">● local settings</span></div><section class="provider-setup"><div class="chat-title"><span class="icon gmail">${icon('settings')}</span><span><b>Mail accounts</b><small>Connections and credentials stay on this Mac.</small></span></div><div id="mail-settings-list" class="provider-options"><div class="loading-state"><span class="spinner"></span> Loading accounts…</div></div></section>`,
    );
    document.querySelector('#back-mail-settings').onclick = onBack;
    fetch('/api/mail/status')
      .then((response) => response.json())
      .then((data) => {
        const list = document.querySelector('#mail-settings-list');
        const accounts = data.accounts || [];
        setHtml(
          list,
          `${accounts.map((account) => `<div class="provider-option"><span><b>${escapeHtml(account.label)} · ${escapeHtml(account.email)}</b><small>Connected via ${escapeHtml(account.transport || 'IMAP')}</small></span><span class="mail-settings-actions"><button class="secondary" data-reconnect="${account.provider}">Add another</button><button class="secondary" data-remove-mail="${escapeHtml(account.id)}">Remove</button></span></div>`).join('')}<div class="provider-option"><span><b>Add mail account</b><small>Connect another Gmail or Zoho Mail inbox.</small></span><span class="mail-settings-actions">${(data.providers || []).map((provider) => `<button class="secondary" data-reconnect="${provider.id}">${provider.label}</button>`).join('')}</span></div>`,
        );
        list
          .querySelectorAll('[data-reconnect]')
          .forEach(
            (button) => (button.onclick = () => showMailProviderSetup(button.dataset.reconnect)),
          );
        list.querySelectorAll('[data-remove-mail]').forEach(
          (button) =>
            (button.onclick = async () => {
              button.disabled = true;
              const result = await fetch('/api/mail/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: button.dataset.removeMail }),
              }).then((response) => response.json());
              if (!result.ok) return notify(result.error || 'Could not remove account');
              notify('Mail account removed');
              showMailSettings();
            }),
        );
      })
      .catch(() => {
        const list = document.querySelector('#mail-settings-list');
        if (list) list.textContent = 'Mail settings are unavailable.';
      });
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
    const subtitle = existingAccount
      ? `${existingAccount.email} stopped authenticating. Enter a fresh app password to reconnect it.`
      : 'Use a provider app password. It stays in macOS Keychain.';
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-mail-setup">${icon('arrow-left')} Mail</button><span class="verified">● IMAP setup</span></div><section class="provider-setup"><div class="chat-title"><span class="icon gmail">${icon('mail')}</span><span><b>${escapeHtml(heading)}</b><small>${escapeHtml(subtitle)}</small></span></div><div class="provider-detail"><div class="provider-fields"><label>Email address<input id="mail-email" type="email" autocomplete="email" value="${escapeHtml(existingAccount?.email || '')}" ${existingAccount ? 'readonly' : ''} /></label><label>App password<input id="mail-app-password" type="password" autocomplete="off" /></label><label>IMAP server<input id="mail-imap-host" value="${host}" autocomplete="off" /></label></div><div class="provider-actions"><span>IMAP uses SSL on port 993.</span><button class="primary" id="connect-mail-provider">${existingAccount ? 'Reconnect' : 'Connect'} <kbd>↵</kbd></button></div></div></section>`,
    );
    document.querySelector('#back-mail-setup').onclick = showMailClient;
    document.querySelector('#connect-mail-provider').onclick = async () => {
      const response = await fetch('/api/mail/imap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          email: document.querySelector('#mail-email').value,
          password: document.querySelector('#mail-app-password').value,
          host: document.querySelector('#mail-imap-host').value,
        }),
      });
      const configured = await response.json();
      if (!configured.ok) return notify(configured.error || 'Could not save mail configuration');
      notify(`${label} connected`);
      showMailClient();
    };
    refreshIcons();
  }

  const composer = createMailComposer({
    defaultView,
    resultsView,
    count,
    notify,
    requestApproval,
    showMailClient,
  });

  inbox = createMailInbox({
    input,
    defaultView,
    resultsView,
    count,
    onHome,
    onOpen,
    showMailThread,
    showMailProviderSetup,
    showMailSettings,
  });
  return {
    search: inbox.search,
    showClient: showMailClient,
    showComposer: composer.show,
    showProviderSetup: showMailProviderSetup,
    showSettings: showMailSettings,
    showThread: showMailThread,
  };
}
