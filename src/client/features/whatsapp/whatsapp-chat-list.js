import { replaceHtml, setHtml } from '../../core/safe-dom.js';
import { initials, refreshIcons, safeImageSrc } from '../../core/view-helpers.js';

export function createWhatsAppChatList({
  input,
  resultsView,
  count,
  resultButton,
  isActive,
  onOpen,
  showChat,
}) {
  let localContactNames = new Map();
  let localContactsRequested = false;
  let contactSearchSequence = 0;
  function showWhatsAppChats() {
    onOpen();
    input.value = '';
    input.placeholder = 'Search WhatsApp chats…';
    // Returning from a chat removes the focused composer from the DOM. Move focus
    // back to the persistent command input so arrows and typing keep working.
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><b>WhatsApp</b><span class="verified">● local session</span></div><div class="loading-state"><span class="spinner"></span> Loading your chats…</div>`,
    );
    Promise.all([
      fetch('/api/whatsapp/chats').then((response) => response.json()),
      loadLocalContacts(),
    ])
      .then(([data]) => {
        const chats = (data.chats || [])
          .filter((chat) => chat.kind !== 'status' && !chat.archived)
          .map(enrichChatWithLocalContact)
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
          .slice(0, 100);
        if (!data.ok) throw new Error(data.error);
        setHtml(
          resultsView,
          `<div class="result-header conversation-mode"><b>WhatsApp</b><span class="verified">● ${chats.length} recent chats</span></div><div class="result-list" data-whatsapp-list>${chats.map((chat, index) => resultButton({ icon: 'whatsapp', title: chat.name || chat.id, meta: chat.lastMessage || 'Open chat', tag: 'CHAT', type: 'chat', chat, timestamp: chat.timestamp, unread: chat.unreadCount, avatar: chat.avatar, initials: initials(chat.name || chat.id), showChatAvatar: true }, index)).join('')}</div>`,
        );
        const pictureIds = chats
          .slice(0, 12)
          .map((chat) => chat.id)
          .join(',');
        let avatarAttempts = 0;
        const hydrateAvatars = () => {
          const list = resultsView.querySelector('[data-whatsapp-list]');
          // The user may have navigated away while profile pictures were in flight.
          // Never let that asynchronous work modify global search results.
          if (!isActive() || !list) return;
          return fetch(`/api/whatsapp/profile-pictures?ids=${encodeURIComponent(pictureIds)}`)
            .then((response) => response.json())
            .then((data) => {
              if (!isActive() || !list.isConnected) return;
              const pictures = data.pictures?.pictures || data.pictures || {};
              chats.forEach((chat, index) => {
                const picture =
                  pictures[chat.id] || pictures.find?.((item) => item.id === chat.id)?.url;
                const iconNode = list.querySelectorAll('.result .icon')[index];
                if (picture && iconNode && !iconNode.querySelector('img'))
                  replaceHtml(
                    iconNode,
                    `<span class="icon chat-avatar"><img src="${safeImageSrc(picture)}" alt="" /></span>`,
                  );
              });
              if (++avatarAttempts < 4 && isActive() && list.isConnected)
                setTimeout(hydrateAvatars, 3500);
            })
            .catch(() => {});
        };
        hydrateAvatars();
        refreshIcons();
      })
      .catch((error) => {
        setHtml(
          resultsView,
          `<div class="local-files-empty">${error.message || 'Could not load WhatsApp chats.'}</div>`,
        );
      });
  }
  function contactDigits(value = '') {
    return String(value).replace(/\D/g, '');
  }
  function enrichChatWithLocalContact(chat) {
    const name = String(chat.name || '').trim();
    if (!/^\+?\d[\d\s()-]{6,}$/.test(name)) return chat;
    const number = contactDigits(chat.id || name);
    const localName =
      localContactNames.get(number) ||
      (number.length >= 10
        ? [...localContactNames.entries()].find(
            ([phone]) => phone.slice(-10) === number.slice(-10),
          )?.[1]
        : '');
    return localName ? { ...chat, name: localName } : chat;
  }
  function loadLocalContacts() {
    const bridge = window.webkit?.messageHandlers?.habibiNative;
    if (!bridge || localContactsRequested) return Promise.resolve(localContactNames);
    localContactsRequested = true;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        window.__habibiNativeContacts = null;
        resolve(localContactNames);
      }, 10_000);
      window.__habibiNativeContacts = (payload) => {
        clearTimeout(timeout);
        window.__habibiNativeContacts = null;
        if (payload?.ok)
          localContactNames = new Map(
            (payload.contacts || []).map((contact) => [contact.phone, contact.name]),
          );
        resolve(localContactNames);
      };
      bridge.postMessage({ type: 'contacts' });
    });
  }
  function filterWhatsAppChats(query) {
    const needle = query.toLowerCase();
    resultsView.querySelector('.contact-search-section')?.remove();
    const rows = [...resultsView.querySelectorAll('.result')];
    rows.forEach((row) => {
      const chat = row.dataset.chat
        ? JSON.parse(decodeURIComponent(row.dataset.chat))
        : { name: row.dataset.title };
      row.hidden = Boolean(needle) && !chatIntentFromSearch(chat, query);
      row.classList.remove('selected');
    });
    const first = rows.find((row) => !row.hidden);
    if (first) first.classList.add('selected');
    count.textContent = `${rows.filter((row) => !row.hidden).length} chats`;
    if (needle.length < 2) return;
    const sequence = ++contactSearchSequence;
    const contactQuery = query.split(/\s+/).find((token) => token.length >= 3) || query;
    fetch(`/api/whatsapp/contacts?q=${encodeURIComponent(contactQuery)}`)
      .then((response) => response.json())
      .then((data) => {
        if (sequence !== contactSearchSequence || input.value.trim() !== query || !data.ok) return;
        const contacts = (data.contacts || []).map((contact) => ({
          id: contact.id,
          name: contact.name || contact.pushName || contact.notify || contact.id,
        }));
        const existing = new Set(
          rows.filter((row) => !row.hidden).map((row) => row.dataset.title.toLowerCase()),
        );
        const additional = contacts.filter((contact) => !existing.has(contact.name.toLowerCase()));
        if (!additional.length) return;
        resultsView.insertAdjacentHTML(
          'beforeend',
          `<section class="contact-search-section inline-section"><div class="result-header"><b>Contacts</b><span>WhatsApp address book</span></div><div class="result-list">${additional.map((contact, index) => resultButton({ icon: 'whatsapp', title: contact.name, meta: 'WhatsApp contact · open conversation', tag: 'CONTACT', type: 'chat', chat: contact, initials: initials(contact.name), showChatAvatar: true }, index)).join('')}</div></section>`,
        );
        const contactRows = [...resultsView.querySelectorAll('.contact-search-section .result')];
        contactRows.forEach((row) => row.classList.remove('selected'));
        if (!first && contactRows[0]) contactRows[0].classList.add('selected');
        count.textContent = `${rows.filter((row) => !row.hidden).length + contactRows.length} matches`;
        refreshIcons();
      })
      .catch(() => {});
  }
  function chatIntentFromSearch(chat, query = '') {
    const name = String(chat.name || chat.pushName || chat.notify || '').trim();
    const words = query.trim().split(/\s+/).filter(Boolean);
    const nameWords = name
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length >= 3);
    const matched = words
      .map((word, index) => ({ word, index }))
      .filter(({ word }) => {
        const value = word.toLowerCase();
        return (
          nameWords.includes(value) ||
          (value.length >= 3 && nameWords.some((nameWord) => nameWord.startsWith(value)))
        );
      });
    if (!matched.length) return null;
    const used = new Set(matched.map((item) => item.index));
    const instruction = words
      .filter((_, index) => !used.has(index))
      .join(' ')
      .replace(/^(?:that|saying|say|to\s+say)\s+/i, '')
      .trim();
    return { instruction, matchCount: matched.length };
  }
  return {
    filter: filterWhatsAppChats,
    intentFromSearch: chatIntentFromSearch,
    show: showWhatsAppChats,
  };
}
