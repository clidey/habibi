import { spinner } from './view-helpers.js';
import { setHtml } from './safe-dom.js';
let pasteBusy = false;
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
  if (pasteBusy) return true;
  window.__habibiBeginNativeClipboardImage?.();
  nativeBridge.postMessage({
    type: 'clipboardImage',
    context: document.querySelector('.mail-compose') ? 'mail' : 'attachment',
  });
  return true;
}

export function installClipboardImageBridge({ notify, onFiles }) {
  let timer;
  const finish = () => {
    pasteBusy = false;
    clearTimeout(timer);
    document.querySelectorAll('[data-native-paste-status]').forEach((node) => node.remove());
  };

  async function receive(payload) {
    if (!payload?.ok || !/^data:image\//.test(payload.dataUrl || ''))
      return notify(payload?.error || 'Habibi could not read an image from the clipboard.');
    if (document.body.dataset.workspace === 'clipboard') {
      window.__habibiDailyChanged?.('clipboard');
      return;
    }
    if (
      document.querySelector('.mail-compose') &&
      payload.path &&
      window.__habibiAttachRecentPath
    ) {
      window.__habibiAttachRecentPath(payload.path, 'Pasted image.png');
      return;
    }
    const [header, encoded = ''] = payload.dataUrl.split(',', 2);
    const mime = header.match(/^data:([^;]+);base64$/i)?.[1] || 'image/png';
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const files = [
      new File([new Blob([bytes], { type: mime })], 'Pasted screenshot.png', { type: mime }),
    ];
    if (
      document.querySelector('.whatsapp-client') &&
      typeof window.__habibiAttachDroppedFiles === 'function'
    )
      return window.__habibiAttachDroppedFiles(files);
    if (
      document.querySelector('#habibi-draft') &&
      typeof window.__habibiAttachPastedFiles === 'function'
    )
      return window.__habibiAttachPastedFiles(files);
    onFiles(files);
  }
  window.__habibiBeginNativeClipboardImage = () => {
    if (pasteBusy) return;
    pasteBusy = true;
    const target = document.querySelector(
      '#habibi-attachments, #whatsapp-attachments, .mail-compose .attachment-list',
    );
    if (target) {
      const status = document.createElement('span');
      status.className = 'native-paste-status';
      status.dataset.nativePasteStatus = '';
      status.setAttribute('role', 'status');
      setHtml(status, spinner(true) + '<span>Adding image…</span>');
      target.append(status);
    } else notify('Adding image…');
    timer = setTimeout(() => {
      finish();
      notify('The image could not be added. Try copying it again.');
    }, 20000);
  };
  window.__habibiReceiveNativeClipboardImage = (payload) => {
    if (typeof window.__habibiClipboardImage === 'function') {
      finish();
      window.__habibiClipboardImage(payload);
      return;
    }
    return receive(payload)
      .catch(() => notify('Habibi could not read an image from the clipboard.'))
      .finally(finish);
  };
  window.__habibiNativePasteImage = () => {
    if (document.body.dataset.workspace === 'clipboard') {
      window.__habibiDailyChanged?.('clipboard');
      return;
    }
    if (!requestNativeClipboardImage())
      notify('Habibi could not read an image from the clipboard.');
  };
}
