import { countBucket, lengthBucket, track } from './core/analytics.js';
import { createKeyboardController } from './core/keyboard-controller.js';
import { pastedImageFiles, requestNativeClipboardImage } from './core/clipboard-images.js';

export function installAppInteractions(deps) {
  const { input, defaultView, resultsView, notify, getMode, onHome, onDismiss, onActivity, renderSearch, whatsapp, mail, platformActions, kubernetes, aiChat, resultActions, openFilePreview } = deps;
  const keyboard = createKeyboardController({ input, defaultView, resultsView, getMode, notify });
  let searchTimer = null;
  document.addEventListener('keydown', event => {
    const confirmation = document.querySelector('.system-action-confirm');
    if (!confirmation || event.metaKey || event.ctrlKey || event.altKey) return;
    const choices = [...confirmation.querySelectorAll('.confirmation-choice:not([disabled])')];
    if (!choices.length) return;
    const consume = () => { event.preventDefault(); event.stopImmediatePropagation(); };
    const selected = Math.max(0, choices.findIndex(button => button.classList.contains('selected')));
    const select = choice => { confirmation.dataset.confirmChoice = choice.dataset.choice || 'confirm'; choices.forEach(button => button.classList.toggle('selected', button === choice)); choice.focus({ preventScroll:true }); };
    if (event.key === 'Escape') { (choices.find(button => button.dataset.choice === 'cancel') || confirmation.querySelector('.back-button'))?.click(); consume(); }
    else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) { select(choices[(selected - 1 + choices.length) % choices.length]); consume(); }
    else if (['ArrowRight', 'ArrowDown'].includes(event.key)) { select(choices[(selected + 1) % choices.length]); consume(); }
    else if (event.key === 'Enter') { (choices.find(button => button.classList.contains('selected')) || choices[0])?.click(); consume(); }
  }, true);
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const target = event.target;
    if (target === input || !(target instanceof HTMLElement) || target.closest('input, textarea, select, [contenteditable="true"], button, a') || !target.closest('.content, #default-view, #results-view')) return;
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    resultsView.classList.contains('hidden') ? keyboard.navigateKeyboard(direction) : keyboard.navigateResults(direction, getMode() !== 'whatsapp');
  }, true);
  input.addEventListener('input', event => {
    const mode = getMode();
    if (mode === 'whatsapp') return whatsapp.filter(event.target.value.trim());
    if (mode === 'mail') return mail.search(event.target.value);
    if (mode === 'running-apps') return platformActions.filterRunning(event.target.value);
    if (mode === 'kubernetes') return;
    const query = event.target.value.trim();
    clearTimeout(searchTimer);
    if (!query) return onHome();
    onActivity();
    searchTimer = setTimeout(() => {
      if (getMode() || input.value.trim() !== query) return;
      track('habibi.search.submitted', { surface:'launcher', query_length_bucket:lengthBucket(query), query_word_count_bucket:countBucket(query.split(/\s+/).filter(Boolean).length), app_type:'native', app_version:'0.1.0' });
      renderSearch(query);
    }, 250);
  });
  input.addEventListener('paste', async event => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const hasImage = [...clipboard.types].some(type => /^image\/|^public\.(png|jpeg|tiff)$/i.test(type));
    const hasFile = [...clipboard.items].some(item => item.kind === 'file') || clipboard.files.length > 0;
    const text = clipboard.getData('text/plain');
    const attachText = String(text || '').trim().length > 50;
    if (hasImage || hasFile || attachText) event.preventDefault();
    const files = await pastedImageFiles(clipboard);
    if (files.length || hasImage || hasFile || attachText) {
      if ((hasImage || hasFile) && !files.length && requestNativeClipboardImage()) return;
      if (hasImage && !files.length) return notify('Habibi could not read that image from the clipboard. Try copying the image itself, not its URL.');
      aiChat.show('', { files, text:files.length ? '' : text });
    }
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.querySelector('.system-action-confirm') && !document.querySelector('#quick-preview')) { event.preventDefault(); return onDismiss(); }
    if (getMode() === 'kubernetes' && event.key === 'Enter') { event.preventDefault(); return kubernetes.runQuery(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const direction = event.key === 'ArrowDown' ? 1 : -1; return resultsView.classList.contains('hidden') ? keyboard.navigateKeyboard(direction) : keyboard.navigateResults(direction, getMode() !== 'whatsapp'); }
    if (event.key === 'Enter' && !resultsView.classList.contains('hidden')) { event.preventDefault(); resultActions.activate(document.querySelector('.result.selected') || document.querySelector('.result')); }
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && event.target.matches('input, textarea')) { event.preventDefault(); event.target.select(); return; }
    const activeResult = document.activeElement.closest?.('.result');
    if (document.activeElement.matches?.('button') && !activeResult && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); return keyboard.navigateKeyboard(event.key === 'ArrowDown' ? 1 : -1); }
    if (!activeResult) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); return keyboard.navigateResults(event.key === 'ArrowDown' ? 1 : -1); }
    if (event.code === 'Space' && activeResult.dataset.path) { event.preventDefault(); event.stopPropagation(); return openFilePreview(decodeURIComponent(activeResult.dataset.path), activeResult.dataset.title); }
    if (event.key === 'Enter') { event.preventDefault(); resultActions.activate(activeResult); }
  });
  return keyboard;
}
