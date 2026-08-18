const shouldAttachPastedText = (text) => String(text || '').trim().length > 50;

export function installChatPaste({
  draft,
  pastedImageFiles,
  requestNativeClipboardImage,
  attachFiles,
  attachPastedText,
  notify,
}) {
  draft.addEventListener('paste', async (event) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const hasImage = [...clipboard.types].some((type) =>
      /^image\/|^public\.(png|jpeg|tiff)$/i.test(type),
    );
    const hasFile =
      [...clipboard.items].some((item) => item.kind === 'file') || clipboard.files.length > 0;
    const text = clipboard.getData('text/plain');
    const isLargeText = shouldAttachPastedText(text);
    if (hasImage || hasFile || isLargeText) event.preventDefault();
    const files = await pastedImageFiles(clipboard);
    if (files.length || hasImage || hasFile) {
      if (files.length) attachFiles(files, 'paste');
      else if (!requestNativeClipboardImage()) {
        notify(
          'Habibi could not read that image from the clipboard. Try copying the image itself, not its URL.',
        );
      }
      return;
    }
    if (isLargeText) attachPastedText(text);
  });
}
