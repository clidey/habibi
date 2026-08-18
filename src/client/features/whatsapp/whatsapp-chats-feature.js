import { createWhatsAppConversation } from './whatsapp-conversation.js';
import { createWhatsAppChatList } from './whatsapp-chat-list.js';
/** Owns WhatsApp chat discovery, contact enrichment, conversation rendering, drafts, and sending. */
export function createWhatsAppChatsFeature({
  input,
  resultsView,
  count,
  resultButton,
  notify,
  requestApproval,
  isActive,
  onOpen,
}) {
  function resolveRecipientIntent(chats, target) {
    const lowerTarget = target.toLowerCase().trim();
    const matches = chats
      .map((chat) => ({ chat, name: (chat.name || '').trim() }))
      .filter((item) => item.name && lowerTarget.startsWith(item.name.toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length);
    if (matches[0])
      return {
        chat: matches[0].chat,
        instruction: target
          .slice(matches[0].name.length)
          .replace(/^(?:\s*(?:about|saying|that|to say)\s*)/i, '')
          .trim(),
      };
    const exact =
      chats.find((chat) => (chat.name || '').toLowerCase() === lowerTarget) ||
      chats.find((chat) => (chat.name || '').toLowerCase().includes(lowerTarget));
    return { chat: exact, instruction: '' };
  }
  function draftWhatsAppMessage(chat, instruction, originalRequest) {
    const composer = document.querySelector('#message-draft');
    if (!composer) return;
    const sendButton = document.querySelector('#send-message');
    composer.placeholder = 'Drafting in your tone…';
    composer.disabled = true;
    if (sendButton) sendButton.disabled = true;
    fetch('/api/llm/status')
      .then((response) => response.json())
      .then((state) => {
        if (!state.configured) throw new Error('Set up a model to create a draft');
        const prompt = `Draft one short message from this anonymized instruction: “${instruction}”. Preserve the language, script, and lingo used in that instruction; Hinglish or any other language is fine. Do not infer or include names, contact details, chat history, or personal facts. Do not invent facts. Output only the message draft—no explanation, greeting label, or quotation marks.`;
        return fetch('/api/llm/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', text: prompt }] }),
        });
      })
      .then((response) => response.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error || 'Could not create a draft');
        if (document.querySelector('#message-draft')) {
          composer.value = data.text.trim();
          composer.placeholder = 'Write a message…';
          composer.disabled = false;
          if (sendButton) sendButton.disabled = false;
          composer.focus();
          notify('Draft ready — review before sending');
        }
      })
      .catch((error) => {
        if (document.querySelector('#message-draft')) {
          composer.placeholder = 'Write a message…';
          composer.disabled = false;
          if (sendButton) sendButton.disabled = false;
          composer.focus();
        }
        notify(error.message || 'Could not create a draft');
      });
  }
  let conversation;
  const chatList = createWhatsAppChatList({
    input,
    resultsView,
    count,
    resultButton,
    isActive,
    onOpen,
    showChat: (...args) => conversation.show(...args),
  });
  conversation = createWhatsAppConversation({
    resultsView,
    notify,
    requestApproval,
    showWhatsAppChats: chatList.show,
  });
  return {
    draftMessage: draftWhatsAppMessage,
    filter: chatList.filter,
    intentFromSearch: chatList.intentFromSearch,
    resolveRecipient: resolveRecipientIntent,
    showChat: conversation.show,
    showChats: chatList.show,
  };
}
