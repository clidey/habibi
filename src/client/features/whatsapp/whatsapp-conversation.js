import { setHtml } from '../../core/safe-dom.js';
import {
  approvalNotice,
  escapeHtml,
  icon,
  initials,
  refreshIcons,
  safeImageSrc,
} from '../../core/view-helpers.js';
import { whatsappMediaMarkup } from './media-markup.js';
import { hydrateChatAvatar } from './chat-avatar.js';

export function createWhatsAppConversation({
  resultsView,
  notify,
  requestApproval,
  showWhatsAppChats,
}) {
  function showWhatsAppChat(chat, draft = '') {
    const avatar = chat.avatar
      ? `<img src="${safeImageSrc(chat.avatar)}" alt="" />`
      : `<span>${escapeHtml(initials(chat.name || chat.id))}</span>`;
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-chats">${icon('arrow-left')} WhatsApp</button><span class="verified">● local session</span></div><section class="chat-client whatsapp-client"><div class="chat-title"><span class="icon chat-avatar" id="chat-avatar">${avatar}</span><span><b>${escapeHtml(chat.name || chat.id)}</b><small>Loading recent history…</small></span></div><div class="messages"><div class="loading-state"><span class="spinner"></span> Loading messages…</div></div><div class="chat-composer"><div id="whatsapp-attachments" class="chat-attachments"></div><textarea id="message-draft" rows="2" placeholder="Write a message…">${escapeHtml(draft)}</textarea><input id="whatsapp-file-input" type="file" multiple hidden /><div class="composer-footer"><span id="whatsapp-composer-note">${approvalNotice('Sending')}</span><span class="composer-actions"><button type="button" class="composer-icon" id="attach-whatsapp" title="Attach files" aria-label="Attach files">${icon('paperclip')}</button><button type="button" class="primary" id="send-message">Send <kbd>⌘ ↵</kbd></button></span></div></div></section>`,
    );
    document.querySelector('#back-chats').onclick = () => {
      window.__habibiAttachDroppedFiles = null;
      showWhatsAppChats();
    };
    let attachments = [];
    const renderAttachments = () => {
      const target = document.querySelector('#whatsapp-attachments');
      if (!target) return;
      setHtml(
        target,
        attachments
          .map(
            (attachment, index) =>
              `<span class="chat-attachment"><i>${/^image\//.test(attachment.mime) ? `<img src="${safeImageSrc(attachment.dataUrl)}" alt="" />` : icon('file')}</i><b>${escapeHtml(attachment.name)}</b><button type="button" data-whatsapp-attachment-index="${index}" aria-label="Remove ${escapeHtml(attachment.name)}">${icon('x')}</button></span>`,
          )
          .join(''),
      );
      target.querySelectorAll('[data-whatsapp-attachment-index]').forEach(
        (button) =>
          (button.onclick = () => {
            attachments.splice(Number(button.dataset.whatsappAttachmentIndex), 1);
            renderAttachments();
          }),
      );
      refreshIcons();
    };
    const attachFiles = (files) => {
      const picked = [...files].slice(0, 5 - attachments.length);
      for (const file of picked) {
        if (file.size > 6 * 1024 * 1024) {
          notify(`${file.name} is larger than 6 MB`);
          continue;
        }
        if (
          attachments.reduce((total, item) => total + item.size, 0) + file.size >
          6 * 1024 * 1024
        ) {
          notify('Attachments are limited to 6 MB per message');
          break;
        }
        const reader = new FileReader();
        reader.onload = () => {
          attachments.push({
            name: file.name || 'Attachment',
            mime: file.type || 'application/octet-stream',
            size: file.size,
            dataUrl: typeof reader.result === 'string' ? reader.result : '',
          });
          renderAttachments();
        };
        reader.readAsDataURL(file);
      }
    };
    // Finder drops reach the native WKWebView host first. It turns those paths
    // back into browser File objects through our loopback-only file endpoint so
    // the rest of the composer follows the exact same validation/send path as a
    // file chosen with the paperclip.
    window.__habibiAttachDroppedFiles = (files) => attachFiles(files);
    const renderMessages = (messages) => {
      const box = document.querySelector('.messages');
      const ordered = [...(messages || [])]
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        .slice(-24);
      setHtml(
        box,
        ordered
          .map(
            (message) =>
              `<div class="message ${message.direction === 'outgoing' ? 'outgoing' : 'incoming'} ${message.metadata?.media ? 'has-media' : ''}">${whatsappMediaMarkup(message)}<time>${message.timestamp ? new Date(message.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</time></div>`,
          )
          .join('') || '<div class="local-files-empty">No recent messages yet.</div>',
      );
      const subtitle = document.querySelector('.chat-title small');
      if (subtitle)
        subtitle.textContent = ordered.length
          ? `${ordered.length} recent messages · WhatsApp`
          : 'No recent messages';
      const scrollToLatest = () => {
        box.scrollTop = box.scrollHeight;
      };
      requestAnimationFrame(scrollToLatest);
      box
        .querySelectorAll('img')
        .forEach((media) =>
          media.complete
            ? requestAnimationFrame(scrollToLatest)
            : media.addEventListener('load', scrollToLatest, { once: true }),
        );
      box
        .querySelectorAll('video')
        .forEach((media) =>
          media.addEventListener('loadedmetadata', scrollToLatest, { once: true }),
        );
    };
    fetch(`/api/whatsapp/history?chatId=${encodeURIComponent(chat.id)}`)
      .then((response) => response.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error);
        renderMessages(data.messages);
      })
      .catch((error) => {
        setHtml(
          document.querySelector('.messages'),
          `<div class="local-files-empty">${error.message || 'Could not load messages.'}</div>`,
        );
      });
    hydrateChatAvatar(chat);
    const send = async () => {
      const composer = document.querySelector('#message-draft');
      const text = composer.value.trim();
      if (!text && !attachments.length) return notify('Write a message or attach a file first');
      const box = document.querySelector('.messages');
      const message = document.createElement('div');
      const body = document.createElement('span');
      const time = document.createElement('time');
      message.className = 'message outgoing sending';
      body.textContent =
        text || `Attached ${attachments.map((attachment) => attachment.name).join(', ')}`;
      time.textContent = 'Sending…';
      message.append(body, time);
      if (attachments.length) {
        const tags = document.createElement('div');
        tags.className = 'message-attachment-tags';
        setHtml(
          tags,
          attachments
            .map(
              (attachment) =>
                `<span>${icon(/^image\//.test(attachment.mime) ? 'image' : 'paperclip')} ${escapeHtml(attachment.name)}</span>`,
            )
            .join(''),
        );
        message.append(tags);
      }
      box.append(message);
      box.scrollTop = box.scrollHeight;
      const pendingAttachments = attachments;
      composer.value = '';
      attachments = [];
      renderAttachments();
      composer.focus();
      let approvalToken;
      const approvalPayload = {
        chatId: chat.id,
        text,
        attachments: pendingAttachments.map(({ name, mime, size }) => ({
          name,
          mime,
          bytes: size,
        })),
      };
      try {
        approvalToken = await requestApproval('whatsapp.send', approvalPayload);
      } catch (error) {
        message.remove();
        composer.value = text;
        attachments = pendingAttachments;
        renderAttachments();
        return notify(error.message);
      }
      fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: chat.id,
          text,
          attachments: pendingAttachments,
          approvalToken,
        }),
      })
        .then((response) => response.json())
        .then((result) => {
          if (!result.ok) throw new Error(result.error);
          message.classList.remove('sending');
          time.textContent = new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });
          notify(`Message sent to ${chat.name || 'chat'}`);
        })
        .catch((error) => {
          message.classList.add('failed');
          time.textContent = 'Not sent';
          composer.value = text;
          attachments = pendingAttachments;
          renderAttachments();
          notify(error.message || 'Could not send message');
        });
    };
    document.querySelector('#send-message').onclick = send;
    document.querySelector('#attach-whatsapp').onclick = () =>
      document.querySelector('#whatsapp-file-input').click();
    document.querySelector('#whatsapp-file-input').onchange = (event) => {
      attachFiles(event.target.files);
      event.target.value = '';
    };
    document
      .querySelector('.whatsapp-client .chat-composer')
      .addEventListener('dragover', (event) => event.preventDefault());
    document.querySelector('.whatsapp-client .chat-composer').addEventListener('drop', (event) => {
      event.preventDefault();
      attachFiles(event.dataTransfer.files);
    });
    document.querySelector('#message-draft').addEventListener('paste', (event) => {
      const files = event.clipboardData?.files;
      if (!files?.length) return;
      event.preventDefault();
      attachFiles(files);
    });
    document.querySelector('#message-draft').addEventListener('keydown', (event) => {
      if (event.metaKey && event.key === 'Enter') send();
    });
    refreshIcons();
    requestAnimationFrame(() => document.querySelector('#message-draft')?.focus());
  }
  return { show: showWhatsAppChat };
}
