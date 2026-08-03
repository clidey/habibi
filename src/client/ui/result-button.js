/**
 * The common command-result control. The caller must opt in to profile images;
 * this prevents an asynchronous connector response from leaking into global UI.
 */
export function createResultButton({ icon, chatTime, iconNames }) {
  return function resultButton(item, index) {
    const pathAttribute = item.path ? ` data-path="${encodeURIComponent(item.path)}"` : '';
    const folderAttribute = item.folder ? ` data-folder="${item.folder}"` : '';
    const chatAttribute = item.chat ? ` data-chat="${encodeURIComponent(JSON.stringify(item.chat))}"` : '';
    const isPdf = item.type === 'file' && /\.pdf$/i.test(item.title);
    const dragAttribute = item.path ? ' draggable="true"' : '';
    const canShowChatAvatar = item.showChatAvatar === true;
    const iconMarkup = canShowChatAvatar && item.avatar ? `<img src="${item.avatar}" alt="" />` : canShowChatAvatar && item.initials ? `<span>${item.initials}</span>` : icon(isPdf ? 'file-text' : iconNames[item.icon]);
    const end = item.timestamp ? `<span class="chat-end"><time>${chatTime(item.timestamp)}</time>${item.unread ? `<b>${item.unread}</b>` : ''}</span>` : `<span class="result-tag">${item.tag}</span>`;
    return `<button class="result ${index === 0 ? 'selected' : ''}" data-type="${item.type}" data-title="${item.title}"${pathAttribute}${folderAttribute}${chatAttribute}${dragAttribute}><span class="icon ${canShowChatAvatar ? 'chat-avatar' : isPdf ? 'pdf' : item.icon}">${iconMarkup}</span><span class="result-copy"><span class="result-title">${item.title}</span><span class="result-meta">${item.meta}</span></span>${end}</button>`;
  };
}
