import { escapeHtml, icon } from '../../core/view-helpers.js';

export function mailThreadListMarkup(threads, connected, emptyCopy = 'No messages matched that search.') {
  if (!threads.length) return `<div class="clear-day"><span class="icon gmail">${icon('inbox')}</span><span><b>${escapeHtml(emptyCopy)}</b><small>Try a sender, subject, or phrase.</small></span></div>`;
  return `<div class="result-list mail-thread-list">${threads.map((thread, index) => {
    const account = connected.find((item) => item.id === thread.accountId);
    const timestamp = new Date(thread.timestamp);
    const when = timestamp.toDateString() === new Date().toDateString() ? timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : timestamp.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `<button class="result ${thread.unread ? 'unread' : ''} ${index === 0 ? 'selected' : ''}" data-mail-thread="${escapeHtml(thread.id)}" data-mail-provider="${escapeHtml(thread.accountId)}"><span class="mail-unread-dot ${thread.unread ? 'unread' : ''}"></span><span class="mail-sender">${escapeHtml(thread.from || 'Unknown sender')}</span><span class="result-copy"><span class="result-title">${escapeHtml(thread.subject || '(No subject)')}</span><span class="result-meta">${escapeHtml(thread.snippet || thread.preview || thread.accountEmail || '')}</span></span><span class="chat-end"><time>${thread.timestamp ? escapeHtml(when) : ''}</time><small>${escapeHtml(account?.label || thread.label || 'Mail')}</small></span></button>`;
  }).join('')}</div>`;
}
