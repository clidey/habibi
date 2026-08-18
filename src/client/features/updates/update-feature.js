import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';
import { setHtml } from '../../core/safe-dom.js';

export function installUpdateFeature(updateButton) {
  let updateState = null;

  function renderDialog(dialog, state) {
    const installing = ['downloading', 'installing'].includes(state?.state);
    const title = installing
      ? state.state === 'downloading'
        ? 'Downloading update…'
        : 'Installing and restarting…'
      : `Habibi ${escapeHtml(state?.version || '')} is ready`;
    const copy = installing
      ? 'Keep this window open. Habibi will close and reopen automatically.'
      : 'The signed update will replace this copy of Habibi, then reopen automatically.';
    const actions = installing
      ? '<span class="mini-spinner"></span>'
      : '<button type="button" class="secondary" data-update-later>Later</button><button type="button" class="primary" data-install-update>Install update</button>';
    setHtml(
      dialog,
      `<section class="update-dialog-card" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title"><span class="icon agents">${icon('download')}</span><div><span class="briefing-heading">HABIBI UPDATE</span><h2 id="update-dialog-title">${title}</h2><p>${copy}</p></div><div class="update-dialog-actions">${actions}</div></section>`,
    );
    dialog.querySelector('[data-update-later]')?.addEventListener('click', () => dialog.remove());
    dialog.querySelector('[data-install-update]')?.addEventListener('click', () => {
      window.webkit?.messageHandlers?.habibiNative?.postMessage({ type: 'installUpdate' });
    });
    refreshIcons();
  }

  function showDialog() {
    if (!updateState?.available || document.querySelector('#update-dialog')) return;
    const dialog = document.createElement('div');
    dialog.id = 'update-dialog';
    document.body.append(dialog);
    renderDialog(dialog, updateState);
    dialog.querySelector('[data-install-update]')?.focus();
  }

  window.__habibiUpdateState = (state) => {
    updateState = state || updateState;
    if (!updateButton || !state?.available) return;
    updateButton.classList.remove('hidden');
    const symbol = ['downloading', 'installing'].includes(state.state)
      ? 'loader-circle'
      : 'download';
    const label =
      state.state === 'downloading'
        ? 'Downloading update…'
        : state.state === 'installing'
          ? 'Installing update…'
          : `Update available · ${state.version}`;
    setHtml(updateButton, `${icon(symbol)} ${escapeHtml(label)}`);
    updateButton.disabled = ['downloading', 'installing'].includes(state.state);
    updateButton.onclick = showDialog;
    const dialog = document.querySelector('#update-dialog');
    if (dialog) renderDialog(dialog, state);
    refreshIcons();
  };
  window.__habibiShowUpdateDialog = showDialog;
  window.webkit?.messageHandlers?.habibiNative?.postMessage({ type: 'checkForUpdate' });
}
