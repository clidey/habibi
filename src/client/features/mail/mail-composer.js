import { setHtml } from '../../core/safe-dom.js';
import { approvalNotice, escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';

export function createMailComposer({
  defaultView,
  resultsView,
  count,
  notify,
  requestApproval,
  showMailClient,
}) {
  let inboxState = null;
  function showEmailComposer(subject, attachment) {
    // Drop-to-compose and the ⌘N shortcut can reach this before the Mail client
    // has ever loaded account status, so fetch it rather than assume it's cached.
    if (!inboxState?.connected) {
      fetch('/api/mail/status')
        .then((response) => response.json())
        .then((data) => {
          inboxState = { connected: (data.accounts || []).filter((account) => account.connected) };
          renderEmailComposer(subject, attachment);
        })
        .catch(() => {
          inboxState = { connected: [] };
          renderEmailComposer(subject, attachment);
        });
      return;
    }
    renderEmailComposer(subject, attachment);
  }
  function renderEmailComposer(subject, attachment) {
    const connected = inboxState?.connected || [];
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = connected.length ? `${connected[0].label} · draft` : 'Mail · draft';
    const accountOptions = connected
      .map(
        (account) =>
          `<option value="${escapeHtml(account.id)}">${escapeHtml(account.label)} · ${escapeHtml(account.email)}</option>`,
      )
      .join('');
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-email-compose">${icon('arrow-left')} Mail</button><span class="verified">● draft stays local</span></div>
    <section class="mail-compose">${connected.length > 1 ? `<div class="mail-line"><span>From</span><select id="mail-from">${accountOptions}</select></div>` : ''}<div class="mail-line"><span>To</span><input id="mail-to" type="email" placeholder="Recipient" aria-label="Email recipient" /></div><div class="mail-line"><span>Subject</span><input id="mail-subject" value="${escapeHtml(subject === 'Gmail' ? '' : subject && subject !== 'New email' ? `Re: ${subject}` : '')}" aria-label="Email subject" /></div><textarea id="mail-body" class="mail-body" placeholder="Write a message…"></textarea><div id="attachment-zone" class="attachment-zone"><span class="icon files">${icon('paperclip')}</span><span><b>Drop a local file here</b><small>It will be attached to this draft</small></span></div><div class="attachment-list"></div><div class="mail-actions"><span>${connected.length ? approvalNotice('Sending') : 'Connect a mail account first'}</span><button class="primary" id="send-email"${connected.length ? '' : ' disabled'}>Send email <kbd>⌘ ↵</kbd></button></div></section>`,
    );
    document.querySelector('#back-email-compose').onclick = showMailClient;
    if (attachment) addAttachment(attachment);
    const zone = document.querySelector('#attachment-zone');
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('drag-over');
      const path = event.dataTransfer.getData('application/x-habibi-file');
      if (path)
        addAttachment({ path, name: event.dataTransfer.getData('application/x-habibi-name') });
    });
    const sendButton = document.querySelector('#send-email');
    const send = async () => {
      if (sendButton.disabled) return;
      const provider =
        connected.length > 1 ? document.querySelector('#mail-from').value : connected[0]?.id;
      const to = document.querySelector('#mail-to').value.trim();
      const subjectValue = document.querySelector('#mail-subject').value.trim();
      const body = document.querySelector('#mail-body').value.trim();
      if (!provider) return notify('Connect a mail account first');
      if (!to) return notify('Enter a recipient');
      if (!body) return notify('Write a message first');
      sendButton.disabled = true;
      const originalLabel = sendButton.innerHTML;
      setHtml(sendButton, '<span class="mini-spinner"></span> Sending');
      try {
        const approvalToken = await requestApproval('mail.send', {
          provider,
          to,
          subject: subjectValue,
          body,
        });
        const result = await fetch('/api/mail/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, to, subject: subjectValue, body, approvalToken }),
        }).then((response) => response.json());
        if (!result.ok) throw new Error(result.error || 'Could not send this email.');
        notify('Email sent');
        showMailClient();
      } catch (error) {
        sendButton.disabled = false;
        setHtml(sendButton, originalLabel);
        notify(error.message || 'Could not send this email.');
      }
    };
    sendButton.onclick = send;
    resultsView.querySelector('.mail-compose').addEventListener('keydown', (event) => {
      if (event.metaKey && event.key === 'Enter') {
        event.preventDefault();
        send();
      }
    });
    refreshIcons();
  }
  function addAttachment(file) {
    const list = document.querySelector('.attachment-list');
    if (!list || list.dataset.path === file.path) return;
    list.dataset.path = file.path;
    const isPdf = /\.pdf$/i.test(file.name);
    setHtml(
      list,
      `<div class="attachment"><span class="icon ${isPdf ? 'pdf' : 'files'}">${icon(isPdf ? 'file-text' : 'file')}</span><span><b>${escapeHtml(file.name)}</b><small>Local file · attached to draft</small></span><button aria-label="Remove attachment">${icon('x')}</button></div>`,
    );
    list.querySelector('button').onclick = () => {
      list.innerHTML = '';
      list.dataset.path = '';
    };
    refreshIcons();
  }

  return { show: showEmailComposer };
}
