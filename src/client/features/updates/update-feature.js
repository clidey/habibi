import { escapeHtml, icon, refreshIcons, spinner } from '../../core/view-helpers.js';
import { setHtml } from '../../core/safe-dom.js';

export function installUpdateFeature(updateButton) {
  let updateState = null;
  let uxDialog;

  function renderDialog(dialog, state) {
    if (uxDialog) uxDialog.update(state);
    else {
      dialog.dataset.uxDialog = 'true';
      const later = () => { uxDialog?.unmount(); uxDialog = null; dialog.remove(); };
      const install = () => window.webkit?.messageHandlers?.habibiNative?.postMessage({ type: 'installUpdate' });
      uxDialog = window.HabibiUx.mountUpdateDialog(dialog, state, later, install);
    }
  }

  function showDialog() {
    if (!updateState?.available || document.querySelector('#update-dialog')) return;
    const dialog = document.createElement('div');
    dialog.id = 'update-dialog';
    document.body.append(dialog);
    renderDialog(dialog, updateState);
    document.querySelector('[data-install-update]')?.focus();
  }

  window.__habibiUpdateState = (state) => {
    updateState = state || updateState;
    if (!updateButton || !state?.available) return;
    updateButton.classList.remove('hidden');
    const symbol = ['downloading', 'installing'].includes(state.state)
      ? spinner(true)
      : icon('download');
    const label =
      state.state === 'downloading'
        ? 'Downloading update…'
        : state.state === 'installing'
          ? 'Installing update…'
          : `Update available · ${state.version}`;
    setHtml(updateButton, `${symbol} ${escapeHtml(label)}`);
    updateButton.disabled = ['downloading', 'installing'].includes(state.state);
    updateButton.onclick = showDialog;
    const dialog = document.querySelector('#update-dialog');
    if (dialog) renderDialog(dialog, state);
    refreshIcons();
  };
  window.__habibiShowUpdateDialog = showDialog;
  window.webkit?.messageHandlers?.habibiNative?.postMessage({ type: 'checkForUpdate' });
}
