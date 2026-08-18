import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons, safeImageSrc } from '../../core/view-helpers.js';

export function createChatAttachments({ notify, initialAttachments }) {
  const attachments = [];
  let pastedAttachmentNumber = 0;
  const renderAttachments = () => {
    const target = document.querySelector('#habibi-attachments');
    setHtml(
      target,
      attachments
        .map(
          (attachment, index) =>
            `<span class="chat-attachment"><i>${attachment.dataUrl && /^image\//.test(attachment.mime) ? `<img src="${safeImageSrc(attachment.dataUrl)}" alt="" />` : icon('file')}</i><b>${escapeHtml(attachment.name)}</b><button data-attachment-index="${index}" aria-label="Remove ${escapeHtml(attachment.name)}">${icon('x')}</button></span>`,
        )
        .join(''),
    );
    target.querySelectorAll('[data-attachment-index]').forEach(
      (button) =>
        (button.onclick = () => {
          attachments.splice(Number(button.dataset.attachmentIndex), 1);
          renderAttachments();
        }),
    );
    refreshIcons();
  };
  const attachFiles = (files, source = 'file') => {
    const picked = [...files].slice(0, 5 - attachments.length);
    picked.forEach((file) => {
      if (file.size > 8 * 1024 * 1024) return notify(`${file.name} is larger than 8 MB`);
      const reader = new FileReader();
      const extension = /^image\//.test(file.type || '')
        ? file.type.split('/')[1] || 'png'
        : 'file';
      const name =
        file.name ||
        `${source === 'paste' ? 'Pasted image' : 'Attachment'} ${++pastedAttachmentNumber}.${extension}`;
      reader.onload = () => {
        attachments.push({
          name,
          mime: file.type || 'application/octet-stream',
          size: file.size,
          dataUrl: typeof reader.result === 'string' ? reader.result : '',
        });
        renderAttachments();
      };
      reader.readAsDataURL(file);
    });
  };
  const attachPastedText = (text) => {
    const value = String(text || '').trim();
    if (!value) return;
    if (attachments.length >= 5) return notify('You can attach up to five items');
    pastedAttachmentNumber += 1;
    attachments.push({
      name: `Pasted note ${pastedAttachmentNumber}.txt`,
      mime: 'text/plain',
      size: new Blob([value]).size,
      text: value,
    });
    renderAttachments();
    notify('Large text attached to this message');
  };
  window.__habibiAttachPastedFiles = (files) => attachFiles(files, 'paste');
  window.__habibiAttachDroppedFiles = (files) => attachFiles(files, 'drop');
  if (initialAttachments.files?.length) attachFiles(initialAttachments.files, 'paste');
  if (initialAttachments.text) attachPastedText(initialAttachments.text);
  return { attachFiles, attachPastedText, items: attachments, render: renderAttachments };
}
