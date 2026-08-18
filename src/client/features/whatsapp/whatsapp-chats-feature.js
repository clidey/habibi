import { replaceHtml, setHtml } from '../../core/safe-dom.js';
import { approvalNotice, escapeHtml, icon, initials, refreshIcons, safeImageSrc, safeMediaSrc } from '../../core/view-helpers.js';
/** Owns WhatsApp chat discovery, contact enrichment, conversation rendering, drafts, and sending. */
export function createWhatsAppChatsFeature({ input, resultsView, count, resultButton, notify, requestApproval, isActive, onOpen }) {
  let chats = [];
  let localContactNames = new Map();
  let localContactsRequested = false;
  let contactSearchSequence = 0;
function resolveRecipientIntent(chats, target) {
  const lowerTarget = target.toLowerCase().trim();
  const matches = chats.map(chat => ({ chat, name:(chat.name || '').trim() })).filter(item => item.name && lowerTarget.startsWith(item.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length);
  if (matches[0]) return { chat:matches[0].chat, instruction:target.slice(matches[0].name.length).replace(/^(?:\s*(?:about|saying|that|to say)\s*)/i, '').trim() };
  const exact = chats.find(chat => (chat.name || '').toLowerCase() === lowerTarget) || chats.find(chat => (chat.name || '').toLowerCase().includes(lowerTarget));
  return { chat:exact, instruction:'' };
}
function draftWhatsAppMessage(chat, instruction, originalRequest) {
  const composer = document.querySelector('#message-draft');
  if (!composer) return;
  const sendButton = document.querySelector('#send-message');
  composer.placeholder = 'Drafting in your tone…'; composer.disabled = true; if (sendButton) sendButton.disabled = true;
  fetch('/api/llm/status').then(response => response.json())
    .then(state => {
      if (!state.configured) throw new Error('Set up a model to create a draft');
      const prompt = `Draft one short message from this anonymized instruction: “${instruction}”. Preserve the language, script, and lingo used in that instruction; Hinglish or any other language is fine. Do not infer or include names, contact details, chat history, or personal facts. Do not invent facts. Output only the message draft—no explanation, greeting label, or quotation marks.`;
      return fetch('/api/llm/chat', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ messages:[{ role:'user', text:prompt }] }) });
    }).then(response => response.json()).then(data => {
      if (!data.ok) throw new Error(data.error || 'Could not create a draft');
      if (document.querySelector('#message-draft')) { composer.value = data.text.trim(); composer.placeholder = 'Write a message…'; composer.disabled = false; if (sendButton) sendButton.disabled = false; composer.focus(); notify('Draft ready — review before sending'); }
    }).catch(error => { if (document.querySelector('#message-draft')) { composer.placeholder = 'Write a message…'; composer.disabled = false; if (sendButton) sendButton.disabled = false; composer.focus(); } notify(error.message || 'Could not create a draft'); });
}
function showWhatsAppChats() {
  onOpen();
  input.value = '';
  input.placeholder = 'Search WhatsApp chats…';
  // Returning from a chat removes the focused composer from the DOM. Move focus
  // back to the persistent command input so arrows and typing keep working.
  requestAnimationFrame(() => input.focus({ preventScroll:true }));
  setHtml(resultsView, `<div class="result-header conversation-mode"><b>WhatsApp</b><span class="verified">● local session</span></div><div class="loading-state"><span class="spinner"></span> Loading your chats…</div>`);
  Promise.all([fetch('/api/whatsapp/chats').then(response => response.json()), loadLocalContacts()]).then(([data]) => {
    const chats = (data.chats || []).filter(chat => chat.kind !== 'status' && !chat.archived).map(enrichChatWithLocalContact).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 100);
    if (!data.ok) throw new Error(data.error);
    setHtml(resultsView, `<div class="result-header conversation-mode"><b>WhatsApp</b><span class="verified">● ${chats.length} recent chats</span></div><div class="result-list" data-whatsapp-list>${chats.map((chat, index) => resultButton({ icon:'whatsapp', title:chat.name || chat.id, meta:chat.lastMessage || 'Open chat', tag:'CHAT', type:'chat', chat, timestamp:chat.timestamp, unread:chat.unreadCount, avatar:chat.avatar, initials:initials(chat.name || chat.id), showChatAvatar:true }, index)).join('')}</div>`);
    const pictureIds = chats.slice(0, 12).map(chat => chat.id).join(',');
    let avatarAttempts = 0;
    const hydrateAvatars = () => {
      const list = resultsView.querySelector('[data-whatsapp-list]');
      // The user may have navigated away while profile pictures were in flight.
      // Never let that asynchronous work modify global search results.
      if (!isActive() || !list) return;
      return fetch(`/api/whatsapp/profile-pictures?ids=${encodeURIComponent(pictureIds)}`).then(response => response.json()).then(data => {
      if (!isActive() || !list.isConnected) return;
      const pictures = data.pictures?.pictures || data.pictures || {};
      chats.forEach((chat, index) => {
        const picture = pictures[chat.id] || pictures.find?.(item => item.id === chat.id)?.url;
        const iconNode = list.querySelectorAll('.result .icon')[index];
        if (picture && iconNode && !iconNode.querySelector('img')) replaceHtml(iconNode, `<span class="icon chat-avatar"><img src="${safeImageSrc(picture)}" alt="" /></span>`);
      });
      if (++avatarAttempts < 4 && isActive() && list.isConnected) setTimeout(hydrateAvatars, 3500);
      }).catch(() => {});
    };
    hydrateAvatars();
    refreshIcons();
  }).catch(error => { setHtml(resultsView, `<div class="local-files-empty">${error.message || 'Could not load WhatsApp chats.'}</div>`); });
}
function contactDigits(value = '') { return String(value).replace(/\D/g, ''); }
function enrichChatWithLocalContact(chat) {
  const name = String(chat.name || '').trim();
  if (!/^\+?\d[\d\s()-]{6,}$/.test(name)) return chat;
  const number = contactDigits(chat.id || name);
  const localName = localContactNames.get(number) || (number.length >= 10 ? [...localContactNames.entries()].find(([phone]) => phone.slice(-10) === number.slice(-10))?.[1] : '');
  return localName ? { ...chat, name:localName } : chat;
}
function loadLocalContacts() {
  const bridge = window.webkit?.messageHandlers?.habibiNative;
  if (!bridge || localContactsRequested) return Promise.resolve(localContactNames);
  localContactsRequested = true;
  return new Promise(resolve => {
    const timeout = setTimeout(() => { window.__habibiNativeContacts = null; resolve(localContactNames); }, 10_000);
    window.__habibiNativeContacts = payload => {
      clearTimeout(timeout); window.__habibiNativeContacts = null;
      if (payload?.ok) localContactNames = new Map((payload.contacts || []).map(contact => [contact.phone, contact.name]));
      resolve(localContactNames);
    };
    bridge.postMessage({ type:'contacts' });
  });
}
function filterWhatsAppChats(query) {
  const needle = query.toLowerCase();
  resultsView.querySelector('.contact-search-section')?.remove();
  const rows = [...resultsView.querySelectorAll('.result')];
  rows.forEach(row => {
    const chat = row.dataset.chat ? JSON.parse(decodeURIComponent(row.dataset.chat)) : { name:row.dataset.title };
    row.hidden = Boolean(needle) && !chatIntentFromSearch(chat, query);
    row.classList.remove('selected');
  });
  const first = rows.find(row => !row.hidden);
  if (first) first.classList.add('selected');
  count.textContent = `${rows.filter(row => !row.hidden).length} chats`;
  if (needle.length < 2) return;
  const sequence = ++contactSearchSequence;
  const contactQuery = query.split(/\s+/).find(token => token.length >= 3) || query;
  fetch(`/api/whatsapp/contacts?q=${encodeURIComponent(contactQuery)}`).then(response => response.json()).then(data => {
    if (sequence !== contactSearchSequence || input.value.trim() !== query || !data.ok) return;
    const contacts = (data.contacts || []).map(contact => ({ id:contact.id, name:contact.name || contact.pushName || contact.notify || contact.id }));
    const existing = new Set(rows.filter(row => !row.hidden).map(row => row.dataset.title.toLowerCase()));
    const additional = contacts.filter(contact => !existing.has(contact.name.toLowerCase()));
    if (!additional.length) return;
    resultsView.insertAdjacentHTML('beforeend', `<section class="contact-search-section inline-section"><div class="result-header"><b>Contacts</b><span>WhatsApp address book</span></div><div class="result-list">${additional.map((contact, index) => resultButton({ icon:'whatsapp', title:contact.name, meta:'WhatsApp contact · open conversation', tag:'CONTACT', type:'chat', chat:contact, initials:initials(contact.name), showChatAvatar:true }, index)).join('')}</div></section>`);
    const contactRows = [...resultsView.querySelectorAll('.contact-search-section .result')];
    contactRows.forEach(row => row.classList.remove('selected'));
    if (!first && contactRows[0]) contactRows[0].classList.add('selected');
    count.textContent = `${rows.filter(row => !row.hidden).length + contactRows.length} matches`;
    refreshIcons();
  }).catch(() => {});
}
function chatIntentFromSearch(chat, query = '') {
  const name = String(chat.name || chat.pushName || chat.notify || '').trim();
  const words = query.trim().split(/\s+/).filter(Boolean);
  const nameWords = name.toLowerCase().split(/\s+/).filter(word => word.length >= 3);
  const matched = words.map((word, index) => ({ word, index })).filter(({ word }) => {
    const value = word.toLowerCase();
    return nameWords.includes(value) || (value.length >= 3 && nameWords.some(nameWord => nameWord.startsWith(value)));
  });
  if (!matched.length) return null;
  const used = new Set(matched.map(item => item.index));
  const instruction = words.filter((_, index) => !used.has(index)).join(' ').replace(/^(?:that|saying|say|to\s+say)\s+/i, '').trim();
  return { instruction, matchCount:matched.length };
}
function whatsappMediaMarkup(message) {
  const media = message.metadata?.media;
  const type = message.type || 'unknown';
  const mime = /^[\w.+/-]+$/.test(String(media?.mimetype || '')) ? media.mimetype : '';
  // `media.data` is connector-supplied base64. Build the URL, then let the
  // shared guard validate the whole thing rather than trusting the parts.
  const source = media?.data && mime ? safeMediaSrc(`data:${mime};base64,${media.data}`) : '';
  const filename = escapeHtml(media?.filename || message.body || (type === 'document' ? 'Document' : 'Media'));
  if (source && type === 'image') return `<div class="media-card image-media"><img src="${source}" alt="Image message" loading="lazy" /></div>`;
  if (source && type === 'video') return `<div class="media-card video-media"><video controls preload="metadata" src="${source}"></video><span>${icon('video')} Video</span></div>`;
  if (source && (type === 'audio' || type === 'voice')) return `<div class="media-card audio-media"><span class="media-glyph">${icon('mic')}</span><audio controls src="${source}"></audio></div>`;
  if (type === 'document') return `<a class="media-card document-media" href="${source || '#'}" ${source ? `download="${filename}"` : ''}><span class="media-glyph">${icon(mime === 'application/pdf' ? 'file-text' : 'file')}</span><span><b>${filename}</b><small>${mime === 'application/pdf' ? 'PDF document' : 'Document'}${source ? ' · Download' : ''}</small></span></a>`;
  if (type !== 'text') return `<div class="media-card generic-media"><span class="media-glyph">${icon(type === 'video' ? 'video' : type === 'image' ? 'image' : 'paperclip')}</span><span><b>${escapeHtml(type === 'unknown' ? 'Media message' : `${type[0].toUpperCase()}${type.slice(1)} message`)}</b><small>${escapeHtml(message.body || 'Open in WhatsApp')}</small></span></div>`;
  return `<span>${escapeHtml(message.body || message.text || message.content || '')}</span>`;
}
function showWhatsAppChat(chat, draft = '') {
  const avatar = chat.avatar ? `<img src="${safeImageSrc(chat.avatar)}" alt="" />` : `<span>${escapeHtml(initials(chat.name || chat.id))}</span>`;
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-chats">${icon('arrow-left')} WhatsApp</button><span class="verified">● local session</span></div><section class="chat-client whatsapp-client"><div class="chat-title"><span class="icon chat-avatar" id="chat-avatar">${avatar}</span><span><b>${escapeHtml(chat.name || chat.id)}</b><small>Loading recent history…</small></span></div><div class="messages"><div class="loading-state"><span class="spinner"></span> Loading messages…</div></div><div class="chat-composer"><div id="whatsapp-attachments" class="chat-attachments"></div><textarea id="message-draft" rows="2" placeholder="Write a message…">${escapeHtml(draft)}</textarea><input id="whatsapp-file-input" type="file" multiple hidden /><div class="composer-footer"><span id="whatsapp-composer-note">${approvalNotice('Sending')}</span><span class="composer-actions"><button type="button" class="composer-icon" id="attach-whatsapp" title="Attach files" aria-label="Attach files">${icon('paperclip')}</button><button type="button" class="primary" id="send-message">Send <kbd>⌘ ↵</kbd></button></span></div></div></section>`);
  document.querySelector('#back-chats').onclick = () => { window.__habibiAttachDroppedFiles = null; showWhatsAppChats(); };
  let attachments = [];
  const renderAttachments = () => {
    const target = document.querySelector('#whatsapp-attachments');
    if (!target) return;
    setHtml(target, attachments.map((attachment, index) => `<span class="chat-attachment"><i>${/^image\//.test(attachment.mime) ? `<img src="${safeImageSrc(attachment.dataUrl)}" alt="" />` : icon('file')}</i><b>${escapeHtml(attachment.name)}</b><button type="button" data-whatsapp-attachment-index="${index}" aria-label="Remove ${escapeHtml(attachment.name)}">${icon('x')}</button></span>`).join(''));
    target.querySelectorAll('[data-whatsapp-attachment-index]').forEach(button => button.onclick = () => { attachments.splice(Number(button.dataset.whatsappAttachmentIndex), 1); renderAttachments(); });
    refreshIcons();
  };
  const attachFiles = files => {
    const picked = [...files].slice(0, 5 - attachments.length);
    for (const file of picked) {
      if (file.size > 6 * 1024 * 1024) { notify(`${file.name} is larger than 6 MB`); continue; }
      if (attachments.reduce((total, item) => total + item.size, 0) + file.size > 6 * 1024 * 1024) { notify('Attachments are limited to 6 MB per message'); break; }
      const reader = new FileReader();
      reader.onload = () => { attachments.push({ name:file.name || 'Attachment', mime:file.type || 'application/octet-stream', size:file.size, dataUrl:typeof reader.result === 'string' ? reader.result : '' }); renderAttachments(); };
      reader.readAsDataURL(file);
    }
  };
  // Finder drops reach the native WKWebView host first. It turns those paths
  // back into browser File objects through our loopback-only file endpoint so
  // the rest of the composer follows the exact same validation/send path as a
  // file chosen with the paperclip.
  window.__habibiAttachDroppedFiles = files => attachFiles(files);
  const renderMessages = messages => { const box = document.querySelector('.messages'); const ordered = [...(messages || [])].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)).slice(-24); setHtml(box, ordered.map(message => `<div class="message ${message.direction === 'outgoing' ? 'outgoing' : 'incoming'} ${message.metadata?.media ? 'has-media' : ''}">${whatsappMediaMarkup(message)}<time>${message.timestamp ? new Date(message.timestamp * 1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : ''}</time></div>`).join('') || '<div class="local-files-empty">No recent messages yet.</div>'); const subtitle = document.querySelector('.chat-title small'); if (subtitle) subtitle.textContent = ordered.length ? `${ordered.length} recent messages · WhatsApp` : 'No recent messages'; const scrollToLatest = () => { box.scrollTop = box.scrollHeight; }; requestAnimationFrame(scrollToLatest); box.querySelectorAll('img').forEach(media => media.complete ? requestAnimationFrame(scrollToLatest) : media.addEventListener('load', scrollToLatest, { once:true })); box.querySelectorAll('video').forEach(media => media.addEventListener('loadedmetadata', scrollToLatest, { once:true })); };
  fetch(`/api/whatsapp/history?chatId=${encodeURIComponent(chat.id)}`).then(response => response.json()).then(data => { if (!data.ok) throw new Error(data.error); renderMessages(data.messages); }).catch(error => { setHtml(document.querySelector('.messages'), `<div class="local-files-empty">${error.message || 'Could not load messages.'}</div>`); });
  let avatarAttempts = 0;
  const hydrateAvatar = () => fetch(`/api/whatsapp/profile-pictures?ids=${encodeURIComponent(chat.id)}`).then(response => response.json()).then(data => {
    const pictures = data.pictures?.pictures || data.pictures || {};
    const picture = pictures[chat.id] || pictures.find?.(item => item.id === chat.id)?.url;
    const avatarNode = document.querySelector('#chat-avatar');
    if (picture && avatarNode && avatarNode.querySelector('img')?.getAttribute('src') !== picture) setHtml(avatarNode, `<img src="${safeImageSrc(picture)}" alt="" />`);
    if (++avatarAttempts < 4 && document.querySelector('#chat-avatar')) setTimeout(hydrateAvatar, 2000);
  }).catch(() => {});
  hydrateAvatar();
  const send = async () => {
    const composer = document.querySelector('#message-draft');
    const text = composer.value.trim();
    if (!text && !attachments.length) return notify('Write a message or attach a file first');
    const box = document.querySelector('.messages');
    const message = document.createElement('div');
    const body = document.createElement('span');
    const time = document.createElement('time');
    message.className = 'message outgoing sending';
    body.textContent = text || `Attached ${attachments.map(attachment => attachment.name).join(', ')}`;
    time.textContent = 'Sending…';
    message.append(body, time);
    if (attachments.length) {
      const tags = document.createElement('div');
      tags.className = 'message-attachment-tags';
      setHtml(tags, attachments.map(attachment => `<span>${icon(/^image\//.test(attachment.mime) ? 'image' : 'paperclip')} ${escapeHtml(attachment.name)}</span>`).join(''));
      message.append(tags);
    }
    box.append(message);
    box.scrollTop = box.scrollHeight;
    const pendingAttachments = attachments;
    composer.value = '';
    attachments = []; renderAttachments();
    composer.focus();
    let approvalToken;
    const approvalPayload = { chatId:chat.id, text, attachments:pendingAttachments.map(({ name, mime, size }) => ({ name, mime, bytes:size })) };
    try { approvalToken = await requestApproval('whatsapp.send', approvalPayload); }
    catch (error) { message.remove(); composer.value = text; attachments = pendingAttachments; renderAttachments(); return notify(error.message); }
    fetch('/api/whatsapp/send', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ chatId:chat.id, text, attachments:pendingAttachments, approvalToken }) })
      .then(response => response.json())
      .then(result => {
        if (!result.ok) throw new Error(result.error);
        message.classList.remove('sending');
        time.textContent = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        notify(`Message sent to ${chat.name || 'chat'}`);
      })
      .catch(error => {
        message.classList.add('failed');
        time.textContent = 'Not sent';
        composer.value = text;
        attachments = pendingAttachments; renderAttachments();
        notify(error.message || 'Could not send message');
      });
  };
  document.querySelector('#send-message').onclick = send;
  document.querySelector('#attach-whatsapp').onclick = () => document.querySelector('#whatsapp-file-input').click();
  document.querySelector('#whatsapp-file-input').onchange = event => { attachFiles(event.target.files); event.target.value = ''; };
  document.querySelector('.whatsapp-client .chat-composer').addEventListener('dragover', event => event.preventDefault());
  document.querySelector('.whatsapp-client .chat-composer').addEventListener('drop', event => { event.preventDefault(); attachFiles(event.dataTransfer.files); });
  document.querySelector('#message-draft').addEventListener('paste', event => {
    const files = event.clipboardData?.files;
    if (!files?.length) return;
    event.preventDefault();
    attachFiles(files);
  });
  document.querySelector('#message-draft').addEventListener('keydown', event => { if (event.metaKey && event.key === 'Enter') send(); });
  refreshIcons();
  requestAnimationFrame(() => document.querySelector('#message-draft')?.focus());
}
  return { draftMessage:draftWhatsAppMessage, filter:filterWhatsAppChats, intentFromSearch:chatIntentFromSearch, resolveRecipient:resolveRecipientIntent, showChat:showWhatsAppChat, showChats:showWhatsAppChats };
}
