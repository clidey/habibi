import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml as e, icon, refreshIcons } from '../../core/view-helpers.js';

export function notesDialog(host, title, content, ready) {
  const previous = document.activeElement;
  let mounted;
  let observer;
  const close = () => {
    observer?.disconnect();
    mounted?.unmount();
    host.replaceChildren();
    previous?.isConnected && previous.focus({ preventScroll: true });
  };
  let root;
  if (window.HabibiUx?.mountNotesDialog) {
    const prepared = document.createElement('div');
    setHtml(prepared, content);
    mounted = window.HabibiUx.mountNotesDialog(host, title, prepared.innerHTML, close);
    root = mounted.root;
    observer = new MutationObserver(() => { if (!host.isConnected) close(); });
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    setHtml(host, `<div class="notes-dialog-backdrop"><section class="notes-dialog" role="dialog" aria-modal="true" aria-labelledby="notes-dialog-title"><header><h3 id="notes-dialog-title">${e(title)}</h3><button type="button" class="notes-icon-button" id="notes-dialog-close" aria-label="Close dialog">${icon('x')}</button></header>${content}</section></div>`);
    root = host.querySelector('.notes-dialog');
    host.querySelector('#notes-dialog-close').onclick = close;
    host.querySelector('.notes-dialog-backdrop').onpointerdown = event => { if (event.target.classList.contains('notes-dialog-backdrop')) close(); };
    root.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    };
  }
  ready(root, close);
  refreshIcons();
  (root.querySelector('input, textarea, button:not(#notes-dialog-close)') || root.querySelector('button')).focus();
  return { root, close };
}
export function folderDialog(host, folders, selected, onSubmit, onRemove) {
  const folder = folders.find(item => item.id === selected);
  return notesDialog(host, folder ? 'Edit folder' : 'New folder', `<label class="notes-dialog-field">Folder name<input id="notes-folder-name" maxlength="100" value="${e(folder?.name || '')}" placeholder="Project, people, ideas…" /></label><p class="notes-dialog-error" role="alert" hidden></p><footer>${folder ? '<button type="button" class="notes-text-button" id="notes-folder-remove">Remove folder</button>' : '<span></span>'}<button type="button" class="primary" id="notes-folder-save">${folder ? 'Save name' : 'Create folder'}</button></footer>${folder ? '<small>Removing a folder keeps its notes and subfolders in the parent folder.</small>' : ''}`, (root, close) => {
    const submit = async action => {
      const error = root.querySelector('.notes-dialog-error');
      try { root.querySelectorAll('button').forEach(button => { button.disabled = true; }); await action(); close(); }
      catch (failure) { error.hidden = false; error.textContent = failure.message; root.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
    };
    root.querySelector('#notes-folder-save').onclick = () => submit(() => onSubmit(root.querySelector('input').value));
    root.querySelector('input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); root.querySelector('#notes-folder-save').click(); } };
    root.querySelector('#notes-folder-remove')?.addEventListener('click', () => submit(onRemove));
  });
}
export function moveDialog(host, folders, active, onSelect) {
  notesDialog(host, 'Move note', `<div class="notes-dialog-options"><button type="button" data-move-folder="">${icon('folder')} No folder${!active ? icon('check') : ''}</button>${folders.map(folder => `<button type="button" data-move-folder="${e(folder.id)}">${icon('folder')} ${e(folder.name)}${active === folder.id ? icon('check') : ''}</button>`).join('')}</div>`, (root, close) => {
    root.querySelectorAll('[data-move-folder]').forEach(button => { button.onclick = () => { onSelect(button.dataset.moveFolder || null); close(); }; });
  });
}
