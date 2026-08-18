import { setHtml } from '../../core/safe-dom.js';
import { safeImageSrc } from '../../core/view-helpers.js';

export function hydrateChatAvatar(chat, attempt = 0) {
  fetch(`/api/whatsapp/profile-pictures?ids=${encodeURIComponent(chat.id)}`)
    .then((response) => response.json())
    .then((data) => {
      const pictures = data.pictures?.pictures || data.pictures || {};
      const picture = pictures[chat.id] || pictures.find?.((item) => item.id === chat.id)?.url;
      const avatarNode = document.querySelector('#chat-avatar');
      if (picture && avatarNode?.querySelector('img')?.getAttribute('src') !== picture) {
        setHtml(avatarNode, `<img src="${safeImageSrc(picture)}" alt="" />`);
      }
      if (attempt < 3 && document.querySelector('#chat-avatar')) {
        setTimeout(() => hydrateChatAvatar(chat, attempt + 1), 2000);
      }
    })
    .catch(() => {});
}
