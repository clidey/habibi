import { countBucket, lengthBucket, track } from '../../core/analytics.js';
import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';
import { createConversationView } from './conversation-view.js';
import { llmProviders } from './provider-catalog.js';
import { createChatAttachments } from './chat-attachments.js';
import { createChatTools } from './chat-tools.js';
import { installChatPaste } from './chat-paste.js';
import { saveEphemeralTurn } from './chat-history.js';

/** Owns ephemeral AI conversation state, attachments, local tool proposals, and model calls. */
export function createAiChatFeature({
  input,
  defaultView,
  resultsView,
  count,
  notify,
  calendar,
  mail,
  onHome,
  onOpen,
  openModelSetup,
  getIntentRouter,
  pastedImageFiles,
  requestNativeClipboardImage,
}) {
  function showEphemeralHabibiChat(initialPrompt = '', initialAttachments = {}) {
    track('habibi.chat.opened', { surface: 'assistant', app_type: 'native', app_version: '0.1.0' });
    onOpen();
    const sessionId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = 'Habibi · ephemeral chat';
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-habibi">${icon('arrow-left')} Habibi</button><span class="verified" id="habibi-provider">● checking model</span></div><section class="chat-client habibi-chat" id="habibi-ephemeral-chat"><div class="chat-title"><span class="habibi-chat-mark chat-title-mark"><img src="/assets/logo.png" alt="Habibi" /><i>${icon('sparkles')}</i></span><span><b>Habibi</b><small>New private conversation · history saved locally</small></span><button class="history-button" id="configure-model">Model settings</button></div><div class="messages" id="habibi-messages"></div><div class="chat-composer"><div id="habibi-attachments" class="chat-attachments"></div><textarea id="habibi-draft" rows="2" placeholder="Ask anything…" disabled></textarea><input id="habibi-file-input" type="file" multiple hidden /><div class="composer-footer"><span id="habibi-composer-note">Checking your model…</span><span class="composer-actions"><button type="button" class="composer-icon" id="attach-habibi" title="Attach files" aria-label="Attach files" disabled>${icon('paperclip')}</button><button type="button" class="primary" id="send-habibi" disabled>Send <kbd>⌘ ↵</kbd></button></span></div></div></section>`,
    );
    const chatLogo = document.createElement('img');
    chatLogo.className = 'identity-logo';
    chatLogo.src = '/assets/logo.png';
    chatLogo.alt = 'Habibi';
    resultsView.querySelector('.chat-title .icon')?.replaceWith(chatLogo);
    const messages = document.querySelector('#habibi-messages');
    const attachmentController = createChatAttachments({ notify, initialAttachments });
    const attachments = attachmentController.items;
    const attachFiles = attachmentController.attachFiles;
    const attachPastedText = attachmentController.attachPastedText;
    const { addTurn } = createConversationView({
      messages,
      notify,
      onTurn: (role, text) => saveEphemeralTurn(sessionId, role, text),
    });
    const conversation = [];
    let sending = false;
    const tools = createChatTools({
      messages,
      conversation,
      addTurn,
      notify,
      calendar,
      mail,
      getIntentRouter,
    });
    const respond = async (prompt, pendingAttachments = []) => {
      const pending = document.createElement('div');
      pending.className = 'message incoming thinking';
      setHtml(pending, '<span class="mini-spinner"></span> Thinking…');
      messages.append(pending);
      messages.scrollTop = messages.scrollHeight;
      try {
        if (!pendingAttachments.length && (await tools.investigateFiles(prompt))) {
          pending.remove();
          return;
        }
        const response = await fetch('/api/llm/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              ...conversation,
              { role: 'user', text: prompt, attachments: pendingAttachments },
            ],
          }),
        });
        const data = await response.json();
        pending.remove();
        if (data.needsConfiguration)
          return openModelSetup({ afterConfigured: () => showEphemeralHabibiChat(prompt) });
        if (!data.ok)
          return addTurn(
            'assistant',
            `I couldn’t reach ${data.provider || 'that model'}: ${data.error}`,
          );
        conversation.push(
          {
            role: 'user',
            text: prompt,
            attachments: pendingAttachments.map(({ name, mime, size }) => ({ name, mime, size })),
          },
          { role: 'assistant', text: data.text },
        );
        addTurn('assistant', data.text || 'The model returned an empty response.');
        if (!/^The user approved preparing/i.test(prompt)) tools.addProposal(data.proposal, prompt);
      } catch (_) {
        pending.remove();
        addTurn(
          'assistant',
          'I couldn’t reach the configured model. Check Model settings and try again.',
        );
      }
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
      if (sendButton) {
        sendButton.disabled = true;
        setHtml(sendButton, '<span class="mini-spinner"></span> Sending');
      }
      if (note) note.textContent = 'Working locally…';
      try {
        if (!attachments.length && text) {
          const priorUserTurn =
            [...conversation].reverse().find((turn) => turn.role === 'user')?.text || '';
          const routingPending = document.createElement('div');
          routingPending.className = 'message incoming thinking';
          setHtml(routingPending, '<span class="mini-spinner"></span> Preparing that…');
          messages.append(routingPending);
          messages.scrollTop = messages.scrollHeight;
          try {
            const route = await fetch('/api/agent/route', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text, context: priorUserTurn }),
            }).then((response) => response.json());
            routingPending.remove();
            if (route.action === 'browser_search' || route.action === 'provider_chat') {
              draft.value = '';
              addTurn('user', text);
              return await getIntentRouter().openBrowser(route);
            }
          } catch (_) {
            routingPending.remove(); /* The conversational model remains available as a fallback. */
          }
        }
        const pendingAttachments = [...attachments];
        track('habibi.chat.sent', {
          surface: 'assistant',
          message_length_bucket: lengthBucket(text),
          attachment_count_bucket: countBucket(pendingAttachments.length),
          has_attachments: Boolean(pendingAttachments.length),
          app_type: 'native',
          app_version: '0.1.0',
        });
        draft.value = '';
        attachments.splice(0, attachments.length);
        attachmentController.render();
        addTurn(
          'user',
          text || `Attached ${pendingAttachments.map((item) => item.name).join(', ')}`,
          pendingAttachments,
        );
        await respond(text || 'Please review the attached file(s).', pendingAttachments);
      } finally {
        sending = false;
        const currentButton = document.querySelector('#send-habibi');
        const currentNote = document.querySelector('#habibi-composer-note');
        if (currentButton) {
          currentButton.disabled = false;
          setHtml(currentButton, 'Send <kbd>⌘ ↵</kbd>');
        }
        if (currentNote) currentNote.textContent = 'This conversation resets when you leave';
        document.querySelector('#habibi-draft')?.focus();
      }
    };
    document.querySelector('#back-habibi').onclick = () => {
      window.__habibiAttachPastedFiles = null;
      window.__habibiAttachDroppedFiles = null;
      onHome();
    };
    document.querySelector('#configure-model').onclick = () =>
      openModelSetup({ afterConfigured: () => showEphemeralHabibiChat() });
    document.querySelector('#attach-habibi').onclick = () =>
      document.querySelector('#habibi-file-input').click();
    document.querySelector('#habibi-file-input').onchange = (event) => {
      attachFiles(event.target.files);
      event.target.value = '';
    };
    document
      .querySelector('.chat-composer')
      .addEventListener('dragover', (event) => event.preventDefault());
    document.querySelector('.chat-composer').addEventListener('drop', (event) => {
      event.preventDefault();
      attachFiles(event.dataTransfer.files);
    });
    installChatPaste({
      draft: document.querySelector('#habibi-draft'),
      pastedImageFiles,
      requestNativeClipboardImage,
      attachFiles,
      attachPastedText,
      notify,
    });
    document.querySelector('#send-habibi').onclick = send;
    document.querySelector('#habibi-draft').addEventListener('keydown', (event) => {
      if (event.metaKey && event.key === 'Enter') send();
    });
    refreshIcons();
    fetch('/api/llm/status')
      .then((response) => response.json())
      .then((state) => {
        const provider = document.querySelector('#habibi-provider');
        const draft = document.querySelector('#habibi-draft');
        const sendButton = document.querySelector('#send-habibi');
        const note = document.querySelector('#habibi-composer-note');
        if (!state.configured)
          return openModelSetup({ afterConfigured: () => showEphemeralHabibiChat(initialPrompt) });
        provider.textContent = `● ${llmProviders[state.provider]?.label || state.provider} · ${state.model}`;
        draft.disabled = false;
        sendButton.disabled = false;
        document.querySelector('#attach-habibi').disabled = false;
        note.textContent = 'This conversation resets when you leave';
        if (initialPrompt.trim()) {
          addTurn('user', initialPrompt.trim());
          requestAnimationFrame(() => respond(initialPrompt.trim()));
        }
        draft.focus();
      })
      .catch(() =>
        openModelSetup({ afterConfigured: () => showEphemeralHabibiChat(initialPrompt) }),
      );
  }

  return { show: showEphemeralHabibiChat };
}
