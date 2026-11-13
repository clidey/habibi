// An absolute local path on macOS/Linux (`/…`) or Windows (`C:\…`, `C:/…`).
const isAbsolutePath = (path) => typeof path === 'string' && /^(?:\/|[A-Za-z]:[\\/])/.test(path);
const baseName = (path) => path.split(/[\\/]/).pop();

export function installFileDrag({ dropDock, notify, onFiles, onComposeMail }) {
  // The desktop shell only starts an OS-level file drag where it can (it sets
  // `__habibiNativeFileDrag`). Elsewhere the ordinary HTML drag below is used,
  // so dropping onto Habibi's own drop dock keeps working.
  const nativeDragHost = () =>
    window.__habibiNativeFileDrag === true ? window.webkit?.messageHandlers?.habibiNative : null;
  const prepareNativeFileDrag = (event) => {
    const result = event.target.closest('.result[data-path], .agent-file[data-path], .recent-file[data-path]');
    const nativeHost = nativeDragHost();
    if (!result || !nativeHost || event.button !== 0) return;
    const path = decodeURIComponent(result.dataset.path);
    nativeHost.postMessage({
      type: 'prepareNativeFileDrag',
      path,
      title: result.dataset.title || baseName(path) || 'file',
    });
  };
  document.addEventListener('pointerdown', prepareNativeFileDrag, true);
  document.addEventListener('mousedown', prepareNativeFileDrag);
  document.addEventListener('dragstart', (event) => {
    const result = event.target.closest('.result[data-path], .agent-file[data-path], .recent-file[data-path]');
    if (!result) return;
    const path = decodeURIComponent(result.dataset.path);
    const title = result.dataset.title || baseName(path) || 'file';
    if (nativeDragHost()) {
      event.preventDefault();
      return;
    }
    const nativeFileUrl = `file://${path.startsWith('/') ? '' : '/'}${path.split(/[\\/]/).map((part, index) => (index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part))).join('/')}`;
    const localUrl = `${window.location.origin}/api/file?path=${encodeURIComponent(path)}`;
    event.dataTransfer.setData('application/x-habibi-file', path);
    event.dataTransfer.setData('application/x-habibi-name', title);
    event.dataTransfer.setData('text/plain', nativeFileUrl);
    event.dataTransfer.setData('text/uri-list', nativeFileUrl);
    event.dataTransfer.setData('DownloadURL', `application/octet-stream:${title}:${localUrl}`);
    event.dataTransfer.effectAllowed = 'copy';
    dropDock.classList.add('visible');
  });
  document.addEventListener('dragend', () => dropDock.classList.remove('visible'));
  window.__habibiNativeDroppedFiles = async (paths) => {
    const safePaths = Array.isArray(paths)
      ? paths.filter(isAbsolutePath).slice(0, 5)
      : [];
    if (!safePaths.length) return;
    try {
      if (document.querySelector('.mail-compose') && window.__habibiAttachRecentPath) { for (const path of safePaths) window.__habibiAttachRecentPath(path, baseName(path)); return; }
      const files = (
        await Promise.all(
          safePaths.map(async (path) => {
            const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
            if (!response.ok) return null;
            const blob = await response.blob();
            return new File([blob], baseName(path) || 'Attachment', {
              type: blob.type || 'application/octet-stream',
            });
          }),
        )
      ).filter(Boolean);
      if (!files.length) return notify('Habibi could not read that dropped file.');
      if (typeof window.__habibiAttachDroppedFiles === 'function' && document.querySelector('.habibi-chat, .whatsapp-client'))
        return window.__habibiAttachDroppedFiles(files);
      onFiles(files);
    } catch (_) {
      notify('Habibi could not read that dropped file.');
    }
  };
  window.__habibiNativeFileDragStarted = () => dropDock.classList.add('visible');
  window.__habibiNativeFileDragEnded = () => dropDock.classList.remove('visible');
  window.__habibiNativeFileDragFailed = () => notify('Could not start a native file drag.');
  dropDock.addEventListener('dragover', (event) => event.preventDefault());
  dropDock.addEventListener('drop', (event) => {
    event.preventDefault();
    const path = event.dataTransfer.getData('application/x-habibi-file');
    if (path) onComposeMail(path, event.dataTransfer.getData('application/x-habibi-name'));
    dropDock.classList.remove('visible');
  });
}
