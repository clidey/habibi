/**
 * The common command-result control. The caller must opt in to profile images;
 * this prevents an asynchronous connector response from leaking into global UI.
 */
export function createResultButton({ icon, chatTime, iconNames }) {
  return function resultButton(item, index) {
    const pathAttribute = item.path ? ` data-path="${encodeURIComponent(item.path)}"` : '';
    const folderAttribute = item.folder ? ` data-folder="${item.folder}"` : '';
    const chatAttribute = item.chat ? ` data-chat="${encodeURIComponent(JSON.stringify(item.chat))}"` : '';
    const systemActionAttribute = item.systemAction ? ` data-system-action="${item.systemAction}"` : '';
    const isPdf = item.type === 'file' && /\.pdf$/i.test(item.title);
    const dragAttribute = item.path ? ' draggable="true"' : '';
    const canShowChatAvatar = item.showChatAvatar === true;
    const habibiSurface = ['assistant', 'whatsapp', 'email', 'event', 'agenda'].includes(item.type);
    const appFallback = '<span class="app-icon-fallback" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect><path d="M3.5 9h17M7 6.75h.01M9.5 6.75h.01"></path></svg></span>';
    const iconMarkup = item.appIcon ? `<img src="${item.appIcon}" alt="" onerror="this.remove();this.closest('.app-icon').classList.add('icon-unavailable')" />${appFallback}` : canShowChatAvatar && item.avatar ? `<img src="${item.avatar}" alt="" />` : canShowChatAvatar && item.initials ? `<span>${item.initials}</span>` : icon(isPdf ? 'file-text' : iconNames[item.icon]);
    const mark = habibiSurface ? '<span class="habibi-mark"><img src="/assets/logo.png" alt="Habibi" /></span>' : '';
    const end = item.timestamp ? `<span class="chat-end"><time>${chatTime(item.timestamp)}</time>${item.unread ? `<b>${item.unread}</b>` : ''}</span>` : `<span class="result-tag ${habibiSurface ? 'habibi-tag' : ''}">${habibiSurface ? 'HABIBI' : item.tag}</span>`;
    return `<button class="result ${index === 0 ? 'selected' : ''}" data-type="${item.type}" data-title="${item.title}"${pathAttribute}${folderAttribute}${chatAttribute}${systemActionAttribute}${dragAttribute}><span class="icon ${item.appIcon ? 'app-icon' : canShowChatAvatar ? 'chat-avatar' : isPdf ? 'pdf' : item.icon}">${iconMarkup}${mark}</span><span class="result-copy"><span class="result-title">${item.title}</span><span class="result-meta">${item.meta}</span></span>${end}</button>`;
  };
}
