import { escapeHtml, safeImageSrc } from '../core/view-helpers.js';

/**
 * The common command-result control. The caller must opt in to profile images;
 * this prevents an asynchronous connector response from leaking into global UI.
 *
 * Every interpolated field is treated as untrusted: titles and metadata carry
 * WhatsApp chat names and message previews, filenames from disk, and app names.
 */
export function createResultButton({ icon, chatTime, iconNames }) {
  return function resultButton(item, index) {
    const pathAttribute = item.path ? ` data-path="${encodeURIComponent(item.path)}"` : '';
    const folderAttribute = item.folder ? ` data-folder="${escapeHtml(item.folder)}"` : '';
    const chatAttribute = item.chat ? ` data-chat="${encodeURIComponent(JSON.stringify(item.chat))}"` : '';
    const systemActionAttribute = item.systemAction ? ` data-system-action="${escapeHtml(item.systemAction)}"` : '';
    const isPdf = item.type === 'file' && /\.pdf$/i.test(item.title);
    const isImage = item.type === 'file' && /\.(?:avif|gif|heic|jpe?g|png|webp)$/i.test(item.title);
    const dragAttribute = item.path ? ' draggable="true"' : '';
    const canShowChatAvatar = item.showChatAvatar === true;
    const habibiSurface = ['assistant', 'whatsapp', 'email', 'event', 'agenda', 'kubernetes'].includes(item.type);
    const appFallback = '<span class="app-icon-fallback" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect><path d="M3.5 9h17M7 6.75h.01M9.5 6.75h.01"></path></svg></span>';
    const iconMarkup = item.appIcon ? `<img src="${safeImageSrc(item.appIcon)}" alt="" onerror="this.remove();this.closest('.app-icon').classList.add('icon-unavailable')" />${appFallback}` : isImage && item.path ? `<img class="file-thumbnail" src="${safeImageSrc(`/api/file?path=${encodeURIComponent(item.path)}`)}" alt="" loading="lazy" onerror="this.remove();this.closest('.file-preview').classList.add('icon-unavailable')" />${icon('image')}` : canShowChatAvatar && item.avatar ? `<img src="${safeImageSrc(item.avatar)}" alt="" />` : canShowChatAvatar && item.initials ? `<span>${escapeHtml(item.initials)}</span>` : item.type === 'assistant' ? `<span class="habibi-chat-mark"><img src="/assets/logo.png" alt="Habibi" /><i>${icon('sparkles')}</i></span>` : item.type === 'kubernetes' ? `<span class="kubernetes-result-wheel">${icon('ship-wheel')}</span>` : icon(isPdf ? 'file-text' : iconNames[item.icon]);
    const mark = habibiSurface && item.type !== 'assistant' ? '<span class="habibi-mark"><img src="/assets/logo.png" alt="Habibi" /></span>' : '';
    const end = item.timestamp ? `<span class="chat-end"><time>${escapeHtml(chatTime(item.timestamp))}</time>${item.unread ? `<b>${escapeHtml(item.unread)}</b>` : ''}</span>` : `<span class="result-tag ${habibiSurface ? 'habibi-tag' : ''}">${habibiSurface ? 'HABIBI' : escapeHtml(item.tag)}</span>`;
    return `<button class="result ${index === 0 ? 'selected' : ''}" data-type="${escapeHtml(item.type)}" data-title="${escapeHtml(item.title)}"${pathAttribute}${folderAttribute}${chatAttribute}${systemActionAttribute}${dragAttribute}><span class="icon ${item.appIcon ? 'app-icon' : isImage ? 'file-preview' : canShowChatAvatar ? 'chat-avatar' : isPdf ? 'pdf' : escapeHtml(item.icon)}">${iconMarkup}${mark}</span><span class="result-copy"><span class="result-title">${escapeHtml(item.title)}</span><span class="result-meta">${escapeHtml(item.meta)}</span></span>${end}</button>`;
  };
}
