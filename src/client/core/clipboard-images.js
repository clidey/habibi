export async function nativeClipboardImageFiles() {
  const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
  if (!nativeBridge) return [];
  try {
    const payload = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.__habibiClipboardImage = null;
        resolve({ ok: false });
      }, 20_000);
      window.__habibiClipboardImage = (value) => {
        clearTimeout(timer);
        window.__habibiClipboardImage = null;
        resolve(value || { ok: false });
      };
      nativeBridge.postMessage({ type: 'clipboardImage' });
    });
    if (payload?.ok && /^data:image\//.test(payload.dataUrl || '')) {
      const response = await fetch(payload.dataUrl);
      const blob = await response.blob();
      return [new File([blob], 'Pasted screenshot.png', { type: blob.type || 'image/png' })];
    }
  } catch (_) {
    /* Clipboard access is best-effort. */
  }
  return [];
}

export async function pastedImageFiles(clipboard) {
  const fromItems = [...(clipboard?.items || [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);
  const direct = fromItems.length ? fromItems : [...(clipboard?.files || [])];
  if (direct.length) return direct;
  const hasImage = [...(clipboard?.types || [])].some((type) =>
    /^image\/|^public\.(png|jpeg|tiff)$/i.test(type),
  );
  if (hasImage && navigator.clipboard?.read) {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((candidate) => candidate.startsWith('image/'));
        if (type)
          return [
            new File([await item.getType(type)], `Pasted image.${type.split('/')[1] || 'png'}`, {
              type,
            }),
          ];
      }
    } catch (_) {
      /* Clipboard privacy controls can deny the fallback. */
    }
  }
  return [];
}

export function requestNativeClipboardImage() {
  const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
  if (!nativeBridge) return false;
  nativeBridge.postMessage({ type: 'clipboardImage' });
  return true;
}

export function installClipboardImageBridge({ notify, onFiles }) {
  async function receive(payload) {
    if (!payload?.ok || !/^data:image\//.test(payload.dataUrl || ''))
      return notify('Habibi could not read an image from the clipboard.');
    const [header, encoded = ''] = payload.dataUrl.split(',', 2);
    const mime = header.match(/^data:([^;]+);base64$/i)?.[1] || 'image/png';
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const files = [
      new File([new Blob([bytes], { type: mime })], 'Pasted screenshot.png', { type: mime }),
    ];
    if (typeof window.__habibiAttachPastedFiles === 'function')
      return window.__habibiAttachPastedFiles(files);
    onFiles(files);
  }
  window.__habibiBeginNativeClipboardImage = () => notify('Adding image…');
  window.__habibiReceiveNativeClipboardImage = (payload) =>
    receive(payload).catch(() => notify('Habibi could not read an image from the clipboard.'));
  window.__habibiNativePasteImage = () => {
    if (!requestNativeClipboardImage())
      notify('Habibi could not read an image from the clipboard.');
  };
}
