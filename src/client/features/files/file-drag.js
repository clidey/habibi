export function installFileDrag({ dropDock, notify, onFiles, onComposeMail }) {
  const prepareNativeFileDrag = event => {
    const result = event.target.closest('.result[data-path], .agent-file[data-path]');
    const nativeHost = window.webkit?.messageHandlers?.habibiNative;
    if (!result || !nativeHost || event.button !== 0) return;
    const path = decodeURIComponent(result.dataset.path);
    nativeHost.postMessage({ type:'prepareNativeFileDrag', path, title:result.dataset.title || path.split('/').pop() || 'file' });
  };
  document.addEventListener('pointerdown', prepareNativeFileDrag, true);
  document.addEventListener('mousedown', prepareNativeFileDrag);
  document.addEventListener('dragstart', event => {
    const result = event.target.closest('.result[data-path], .agent-file[data-path]');
    if (!result) return;
    const path = decodeURIComponent(result.dataset.path);
    const title = result.dataset.title || path.split('/').pop() || 'file';
    if (window.webkit?.messageHandlers?.habibiNative) { event.preventDefault(); return; }
    const nativeFileUrl = `file://${path.split('/').map(encodeURIComponent).join('/')}`;
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
  window.__habibiNativeDroppedFiles = async paths => {
    const safePaths = Array.isArray(paths) ? paths.filter(path => typeof path === 'string' && path.startsWith('/')).slice(0, 5) : [];
    if (!safePaths.length) return;
    try {
      const files = (await Promise.all(safePaths.map(async path => {
        const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
        if (!response.ok) return null;
        const blob = await response.blob();
        return new File([blob], path.split('/').pop() || 'Attachment', { type:blob.type || 'application/octet-stream' });
      }))).filter(Boolean);
      if (!files.length) return notify('Habibi could not read that dropped file.');
      if (typeof window.__habibiAttachDroppedFiles === 'function') return window.__habibiAttachDroppedFiles(files);
      onFiles(files);
    } catch (_) { notify('Habibi could not read that dropped file.'); }
  };
  window.__habibiNativeFileDragStarted = () => dropDock.classList.add('visible');
  window.__habibiNativeFileDragEnded = () => dropDock.classList.remove('visible');
  window.__habibiNativeFileDragFailed = () => notify('Could not start a native file drag.');
  dropDock.addEventListener('dragover', event => event.preventDefault());
  dropDock.addEventListener('drop', event => {
    event.preventDefault();
    const path = event.dataTransfer.getData('application/x-habibi-file');
    if (path) onComposeMail(path, event.dataTransfer.getData('application/x-habibi-name'));
    dropDock.classList.remove('visible');
  });
}
