import { countBucket, lengthBucket, track } from '../../core/analytics.js';
import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons, safeImageSrc } from '../../core/view-helpers.js';
import { calendarDraftFromText } from '../calendar/event-intent.js';
import { createConversationView } from './conversation-view.js';
import { llmProviders } from './provider-catalog.js';

const historyKey = 'habibi.ephemeral-conversation-history.v1';
const pastedTextAttachmentThreshold = 50;
const shouldAttachPastedText = text => String(text || '').trim().length > pastedTextAttachmentThreshold;

/** Owns ephemeral AI conversation state, attachments, local tool proposals, and model calls. */
export function createAiChatFeature({ input, defaultView, resultsView, count, notify, calendar, mail, onHome, onOpen, openModelSetup, getIntentRouter, pastedImageFiles, requestNativeClipboardImage }) {
  function saveEphemeralTurn(sessionId, role, text) {
    try { const history = JSON.parse(localStorage.getItem(historyKey) || '[]'); history.push({ sessionId, role, text, createdAt:Date.now() }); localStorage.setItem(historyKey, JSON.stringify(history.slice(-200))); }
    catch (_) { /* Conversation history is best-effort local state. */ }
  }

function showEphemeralHabibiChat(initialPrompt = '', initialAttachments = {}) {
  track('habibi.chat.opened', { surface:'assistant', app_type:'native', app_version:'0.1.0' });
  onOpen();
  const sessionId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  defaultView.classList.add('hidden');
  resultsView.classList.remove('hidden');
  count.textContent = 'Habibi · ephemeral chat';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-habibi">${icon('arrow-left')} Habibi</button><span class="verified" id="habibi-provider">● checking model</span></div><section class="chat-client habibi-chat" id="habibi-ephemeral-chat"><div class="chat-title"><span class="habibi-chat-mark chat-title-mark"><img src="/assets/logo.png" alt="Habibi" /><i>${icon('sparkles')}</i></span><span><b>Habibi</b><small>New private conversation · history saved locally</small></span><button class="history-button" id="configure-model">Model settings</button></div><div class="messages" id="habibi-messages"></div><div class="chat-composer"><div id="habibi-attachments" class="chat-attachments"></div><textarea id="habibi-draft" rows="2" placeholder="Ask anything…" disabled></textarea><input id="habibi-file-input" type="file" multiple hidden /><div class="composer-footer"><span id="habibi-composer-note">Checking your model…</span><span class="composer-actions"><button type="button" class="composer-icon" id="attach-habibi" title="Attach files" aria-label="Attach files" disabled>${icon('paperclip')}</button><button type="button" class="primary" id="send-habibi" disabled>Send <kbd>⌘ ↵</kbd></button></span></div></div></section>`);
  const chatLogo = document.createElement('img'); chatLogo.className = 'identity-logo'; chatLogo.src = '/assets/logo.png'; chatLogo.alt = 'Habibi';
  resultsView.querySelector('.chat-title .icon')?.replaceWith(chatLogo);
  const messages = document.querySelector('#habibi-messages');
  let attachments = [];
  let pastedAttachmentNumber = 0;
  const renderAttachments = () => {
    const target = document.querySelector('#habibi-attachments');
    setHtml(target, attachments.map((attachment, index) => `<span class="chat-attachment"><i>${attachment.dataUrl && /^image\//.test(attachment.mime) ? `<img src="${safeImageSrc(attachment.dataUrl)}" alt="" />` : icon('file') }</i><b>${escapeHtml(attachment.name)}</b><button data-attachment-index="${index}" aria-label="Remove ${escapeHtml(attachment.name)}">${icon('x')}</button></span>`).join(''));
    target.querySelectorAll('[data-attachment-index]').forEach(button => button.onclick = () => { attachments.splice(Number(button.dataset.attachmentIndex), 1); renderAttachments(); });
    refreshIcons();
  };
  const attachFiles = (files, source = 'file') => {
    const picked = [...files].slice(0, 5 - attachments.length);
    picked.forEach(file => {
      if (file.size > 8 * 1024 * 1024) return notify(`${file.name} is larger than 8 MB`);
      const reader = new FileReader();
      const extension = /^image\//.test(file.type || '') ? (file.type.split('/')[1] || 'png') : 'file';
      const name = file.name || `${source === 'paste' ? 'Pasted image' : 'Attachment'} ${++pastedAttachmentNumber}.${extension}`;
      reader.onload = () => { attachments.push({ name, mime:file.type || 'application/octet-stream', size:file.size, dataUrl:typeof reader.result === 'string' ? reader.result : '' }); renderAttachments(); };
      reader.readAsDataURL(file);
    });
  };
  const attachPastedText = text => {
    const value = String(text || '').trim();
    if (!value) return;
    if (attachments.length >= 5) return notify('You can attach up to five items');
    pastedAttachmentNumber += 1;
    attachments.push({ name:`Pasted note ${pastedAttachmentNumber}.txt`, mime:'text/plain', size:new Blob([value]).size, text:value });
    renderAttachments();
    notify('Large text attached to this message');
  };
  window.__habibiAttachPastedFiles = files => attachFiles(files, 'paste');
  window.__habibiAttachDroppedFiles = files => attachFiles(files, 'drop');
  if (initialAttachments.files?.length) attachFiles(initialAttachments.files, 'paste');
  if (initialAttachments.text) attachPastedText(initialAttachments.text);
  const { addTurn } = createConversationView({ messages, notify, onTurn:(role, text) => saveEphemeralTurn(sessionId, role, text) });
  const conversation = [];
  let sending = false;
  const addProposal = (proposal, sourceText) => {
    if (!proposal) return;
    const card = document.createElement('section');
    card.className = 'agent-proposal';
    setHtml(card, `<span class="icon agents">${icon(proposal.kind === 'calendar_draft' ? 'calendar-days' : proposal.kind === 'email_draft' ? 'mail' : 'message-circle-more')}</span><span><b>${escapeHtml(proposal.label)} available</b><small>${escapeHtml(proposal.detail)}</small></span><button type="button">Prepare draft</button>`);
    card.querySelector('button').onclick = () => {
      if (proposal.kind === 'calendar_draft') return calendar.showDraft(calendarDraftFromText(sourceText));
      if (proposal.kind === 'email_draft') return mail.showClient({ compose:true });
      const intent = getIntentRouter().parse(sourceText);
      if (intent?.kind === 'whatsapp') return getIntentRouter().route(intent);
      notify('Tell Habibi who the message is for to prepare the local draft.');
    };
    messages.append(card); messages.scrollTop = messages.scrollHeight; refreshIcons();
  };
  const addFileCandidates = files => {
    if (!files.length) return;
    const list = document.createElement('div');
    const visualFile = file => /\.(?:avif|gif|jpe?g|png|webp|heic)$/i.test(file.name || '');
    const visualOnly = files.length > 0 && files.every(visualFile);
    list.className = `agent-file-results${visualOnly ? ' agent-file-results--visual' : ''}`;
    setHtml(list, files.map(file => {
      const fileUrl = `/api/file?path=${encodeURIComponent(file.path)}`;
      const preview = visualFile(file)
        ? `<img class="agent-file-thumbnail" src="${safeImageSrc(fileUrl)}" alt="" loading="lazy" />`
        : `<span class="icon files">${icon('file-text')}</span>`;
      return `<button class="agent-file" type="button" draggable="true" data-path="${encodeURIComponent(file.path)}" data-title="${escapeHtml(file.name)}">${preview}<span><b>${escapeHtml(file.name)}</b><small>${escapeHtml(file.folder)} · ${escapeHtml(file.directory)}</small></span><i>${icon('arrow-up-right')}</i></button>`;
    }).join(''));
    list.querySelectorAll('[data-path]').forEach(button => button.onclick = async () => {
      const result = await fetch('/api/open-file', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ path:decodeURIComponent(button.dataset.path) }) }).then(response => response.json()).catch(() => ({ ok:false }));
      notify(result.ok ? 'Opened local file' : 'Could not open that file');
    });
    messages.append(list); messages.scrollTop = messages.scrollHeight; refreshIcons();
  };
  const addAgentTrace = trace => {
    if (!trace?.length) return;
    const panel = document.createElement('details');
    panel.className = 'agent-trace';
    setHtml(panel, `<summary>${icon('route')} Local investigation <span>${trace.length} step${trace.length === 1 ? '' : 's'}</span></summary><ol>${trace.map(step => `<li><span>${icon('check')}</span><span><b>${escapeHtml(step.tool)}</b><small>${escapeHtml(step.detail)}</small></span></li>`).join('')}</ol>`);
    messages.append(panel); messages.scrollTop = messages.scrollHeight; refreshIcons();
  };
  const investigateFiles = async prompt => {
    track('habibi.file-investigation.started', { surface:'assistant', app_type:'native', app_version:'0.1.0' });
    // Finder/TCC may ask for Desktop, Documents, or Downloads while this
    // request is running. Tell the native host first so its ordinary
    // click-away behavior does not dismiss the exact conversation that asked.
    const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
    nativeBridge?.postMessage({ type:'permissionFlow', active:true });
    let result;
    try {
      const response = await fetch('/api/agent/files/investigate', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ history:[...conversation, { role:'user', text:prompt }] }) });
      result = await response.json();
    } finally {
      nativeBridge?.postMessage({ type:'permissionFlow', active:false });
    }
    if (!result.ok || result.phase === 'not_applicable') return false;
    if (result.phase === 'clarify') {
      const question = result.question || 'What detail would help narrow the local search?';
      conversation.push({ role:'user', text:prompt }, { role:'assistant', text:question });
      addAgentTrace(result.trace);
      addTurn('assistant', question);
      track('habibi.file-investigation.completed', { outcome:'clarify', trace_step_count_bucket:countBucket(result.trace?.length || 0), app_type:'native', app_version:'0.1.0' });
      return true;
    }
    const summary = result.summary || 'I searched your local files.';
    conversation.push({ role:'user', text:prompt }, { role:'assistant', text:summary });
    addAgentTrace(result.trace);
    addTurn('assistant', summary);
    addFileCandidates(result.files || []);
    track('habibi.file-investigation.completed', { outcome:(result.files || []).length ? 'results' : 'empty', file_candidate_count_bucket:countBucket((result.files || []).length), trace_step_count_bucket:countBucket(result.trace?.length || 0), app_type:'native', app_version:'0.1.0' });
    return true;
  };
  const respond = async (prompt, pendingAttachments = []) => {
    const pending = document.createElement('div');
    pending.className = 'message incoming thinking';
    setHtml(pending, '<span class="mini-spinner"></span> Thinking…');
    messages.append(pending); messages.scrollTop = messages.scrollHeight;
    try {
      if (!pendingAttachments.length && await investigateFiles(prompt)) { pending.remove(); return; }
      const response = await fetch('/api/llm/chat', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ messages:[...conversation, { role:'user', text:prompt, attachments:pendingAttachments }] }) });
      const data = await response.json();
      pending.remove();
      if (data.needsConfiguration) return openModelSetup({ afterConfigured:() => showEphemeralHabibiChat(prompt) });
      if (!data.ok) return addTurn('assistant', `I couldn’t reach ${data.provider || 'that model'}: ${data.error}`);
      conversation.push({ role:'user', text:prompt, attachments:pendingAttachments.map(({ name, mime, size }) => ({ name, mime, size })) }, { role:'assistant', text:data.text });
      addTurn('assistant', data.text || 'The model returned an empty response.');
      if (!/^The user approved preparing/i.test(prompt)) addProposal(data.proposal, prompt);
    } catch (_) { pending.remove(); addTurn('assistant', 'I couldn’t reach the configured model. Check Model settings and try again.'); }
  };
  const send = async () => {
    const draft = document.querySelector('#habibi-draft');
    const text = draft.value.trim();
    if (!text && !attachments.length) return;
    if (sending) return;
    const appIntent = !attachments.length && getIntentRouter().parse(text);
    if (appIntent?.kind === 'whatsapp') return getIntentRouter().route(appIntent);
    const sendButton = document.querySelector('#send-habibi');
    const note = document.querySelector('#habibi-composer-note');
    sending = true;
    if (sendButton) { sendButton.disabled = true; setHtml(sendButton, '<span class="mini-spinner"></span> Sending'); }
    if (note) note.textContent = 'Working locally…';
    try {
      if (!attachments.length && text) {
        const priorUserTurn = [...conversation].reverse().find(turn => turn.role === 'user')?.text || '';
        const routingPending = document.createElement('div');
        routingPending.className = 'message incoming thinking';
        setHtml(routingPending, '<span class="mini-spinner"></span> Preparing that…');
        messages.append(routingPending); messages.scrollTop = messages.scrollHeight;
        try {
          const route = await fetch('/api/agent/route', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ text, context:priorUserTurn }) }).then(response => response.json());
          routingPending.remove();
          if (route.action === 'browser_search' || route.action === 'provider_chat') {
            draft.value = '';
            addTurn('user', text);
            return await getIntentRouter().openBrowser(route);
          }
        } catch (_) { routingPending.remove(); /* The conversational model remains available as a fallback. */ }
      }
      const pendingAttachments = attachments;
      track('habibi.chat.sent', { surface:'assistant', message_length_bucket:lengthBucket(text), attachment_count_bucket:countBucket(pendingAttachments.length), has_attachments:Boolean(pendingAttachments.length), app_type:'native', app_version:'0.1.0' });
      draft.value = '';
      attachments = []; renderAttachments();
      addTurn('user', text || `Attached ${pendingAttachments.map(item => item.name).join(', ')}`, pendingAttachments);
      await respond(text || 'Please review the attached file(s).', pendingAttachments);
    } finally {
      sending = false;
      const currentButton = document.querySelector('#send-habibi');
      const currentNote = document.querySelector('#habibi-composer-note');
      if (currentButton) { currentButton.disabled = false; setHtml(currentButton, 'Send <kbd>⌘ ↵</kbd>'); }
      if (currentNote) currentNote.textContent = 'This conversation resets when you leave';
      document.querySelector('#habibi-draft')?.focus();
    }
  };
  document.querySelector('#back-habibi').onclick = () => { window.__habibiAttachPastedFiles = null; window.__habibiAttachDroppedFiles = null; onHome(); };
  document.querySelector('#configure-model').onclick = () => openModelSetup({ afterConfigured:() => showEphemeralHabibiChat() });
  document.querySelector('#attach-habibi').onclick = () => document.querySelector('#habibi-file-input').click();
  document.querySelector('#habibi-file-input').onchange = event => { attachFiles(event.target.files); event.target.value = ''; };
  document.querySelector('.chat-composer').addEventListener('dragover', event => event.preventDefault());
  document.querySelector('.chat-composer').addEventListener('drop', event => { event.preventDefault(); attachFiles(event.dataTransfer.files); });
  document.querySelector('#habibi-draft').addEventListener('paste', async event => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const hasImage = [...clipboard.types].some(type => /^image\/|^public\.(png|jpeg|tiff)$/i.test(type));
    const hasFile = [...clipboard.items].some(item => item.kind === 'file') || clipboard.files.length > 0;
    const text = clipboard.getData('text/plain');
    const isLargeText = shouldAttachPastedText(text);
    if (hasImage || hasFile || isLargeText) event.preventDefault();
    const files = await pastedImageFiles(clipboard);
    if (files.length || hasImage || hasFile) {
      if (files.length) attachFiles(files, 'paste');
      else if (!requestNativeClipboardImage()) notify('Habibi could not read that image from the clipboard. Try copying the image itself, not its URL.');
      return;
    }
    // Preserve normal paste for a sentence or short instruction. Longer prose
    // becomes an explicit, removable attachment chip, just like WhoDB's input.
    if (shouldAttachPastedText(text)) { event.preventDefault(); attachPastedText(text); }
  });
  document.querySelector('#send-habibi').onclick = send;
  document.querySelector('#habibi-draft').addEventListener('keydown', event => { if (event.metaKey && event.key === 'Enter') send(); });
  refreshIcons();
  fetch('/api/llm/status').then(response => response.json()).then(state => {
    const provider = document.querySelector('#habibi-provider'); const draft = document.querySelector('#habibi-draft'); const sendButton = document.querySelector('#send-habibi'); const note = document.querySelector('#habibi-composer-note');
    if (!state.configured) return openModelSetup({ afterConfigured:() => showEphemeralHabibiChat(initialPrompt) });
    provider.textContent = `● ${llmProviders[state.provider]?.label || state.provider} · ${state.model}`;
    draft.disabled = false; sendButton.disabled = false; document.querySelector('#attach-habibi').disabled = false; note.textContent = 'This conversation resets when you leave';
    if (initialPrompt.trim()) { addTurn('user', initialPrompt.trim()); requestAnimationFrame(() => respond(initialPrompt.trim())); }
    draft.focus();
  }).catch(() => openModelSetup({ afterConfigured:() => showEphemeralHabibiChat(initialPrompt) }));
  }

  return { show:showEphemeralHabibiChat };
}
