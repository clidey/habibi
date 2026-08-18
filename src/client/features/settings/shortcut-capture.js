import { refreshIcons } from '../../core/view-helpers.js';

const onboardingShortcutKey = 'habibi.getting-started.shortcut-set.v1';
const shortcutKeyCodes = {
  Space: 49,
  Enter: 36,
  Escape: 53,
  Tab: 48,
  Backspace: 51,
  Delete: 117,
  ArrowUp: 126,
  ArrowDown: 125,
  ArrowLeft: 123,
  ArrowRight: 124,
  Home: 115,
  End: 119,
  PageUp: 116,
  PageDown: 121,
};
'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((letter, index) => {
  shortcutKeyCodes[`Key${letter}`] = [
    0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6,
  ][index];
});
'0123456789'.split('').forEach((digit, index) => {
  shortcutKeyCodes[`Digit${digit}`] = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25][index];
});
function shortcutLabel(shortcut) {
  return `${shortcut.meta ? '⌘ ' : ''}${shortcut.alt ? '⌥ ' : ''}${shortcut.ctrl ? '⌃ ' : ''}${shortcut.shift ? '⇧ ' : ''}${shortcut.key || 'shortcut'}`.trim();
}
function shortcutPayload(event) {
  const keyCode = shortcutKeyCodes[event.code];
  if (keyCode === undefined || (!event.metaKey && !event.altKey && !event.ctrlKey)) return null;
  return {
    keyCode,
    modifiers:
      (event.metaKey ? 256 : 0) |
      (event.altKey ? 2048 : 0) |
      (event.ctrlKey ? 4096 : 0) |
      (event.shiftKey ? 512 : 0),
    meta: event.metaKey,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    key:
      event.code === 'Space'
        ? 'Space'
        : event.key.length === 1
          ? event.key.toUpperCase()
          : event.key,
  };
}

export function createShortcutCapture() {
  let activeShortcutCapture = null;
  function install({ native, focus }) {
    const listen = document.querySelector('#shortcut-listen');
    const candidate = document.querySelector('#shortcut-candidate');
    const candidateLabel = document.querySelector('#shortcut-candidate-label');
    const candidateStatus = document.querySelector('#shortcut-candidate-status');
    const save = document.querySelector('#shortcut-save');
    let pendingShortcut = null;
    let captureTimeout = null;
    const stopListening = () => {
      window.removeEventListener('keydown', onShortcutKey, true);
      clearTimeout(captureTimeout);
      captureTimeout = null;
      if (activeShortcutCapture === stopListening) activeShortcutCapture = null;
      if (!listen?.isConnected) return;
      listen.classList.remove('listening');
      listen.querySelector('b').textContent = 'Click, then press a shortcut';
    };
    const onShortcutKey = (event) => {
      if (!listen.classList.contains('listening')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        candidate.classList.add('hidden');
        stopListening();
        return;
      }
      // Modifier keys are part of a chord, never a completed shortcut. Keep
      // capture mode alive and swallow every event so the launcher cannot react.
      if (['Meta', 'Alt', 'Control', 'Shift'].includes(event.key)) return;
      const value = shortcutPayload(event);
      candidate.classList.remove('hidden');
      save.disabled = true;
      if (!value) {
        candidateLabel.textContent = 'Choose a modified key';
        candidateStatus.textContent = 'Use ⌘, ⌥, or ⌃ with a key.';
        candidate.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        stopListening();
        return;
      }
      pendingShortcut = value;
      candidateLabel.textContent = `Shortcut captured: ${shortcutLabel(value)}`;
      candidateStatus.textContent = native
        ? 'Checking availability…'
        : 'Open Habibi.app to check this shortcut.';
      candidate.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      stopListening();
      if (native)
        window.webkit.messageHandlers.habibiNative.postMessage({ type: 'shortcutCheck', ...value });
    };
    window.__habibiShortcutValidation = (result) => {
      if (!pendingShortcut || !candidate?.isConnected) return;
      candidateStatus.textContent =
        result.message || (result.available ? 'Available' : 'Already in use');
      candidate.classList.toggle('available', Boolean(result.available));
      save.disabled = !result.available;
      if (result.saved) {
        localStorage.setItem(onboardingShortcutKey, 'done');
        document.body.dataset.nativeShortcutLabel = shortcutLabel(pendingShortcut);
        document.querySelector('#shortcut-current').textContent = shortcutLabel(pendingShortcut);
        candidateStatus.textContent = 'Saved — Habibi will use this globally.';
        save.disabled = true;
      }
    };
    listen.onclick = () => {
      activeShortcutCapture?.();
      listen.classList.add('listening');
      listen.querySelector('b').textContent = 'Listening… press your shortcut';
      candidate.classList.add('hidden');
      activeShortcutCapture = stopListening;
      window.addEventListener('keydown', onShortcutKey, true);
      captureTimeout = setTimeout(() => {
        if (listen.classList.contains('listening')) {
          candidate.classList.remove('hidden');
          candidateLabel.textContent = 'Stopped listening';
          candidateStatus.textContent = 'Click once more whenever you are ready.';
          stopListening();
        }
      }, 12_000);
    };
    save.onclick = () => {
      if (pendingShortcut && native)
        window.webkit.messageHandlers.habibiNative.postMessage({
          type: 'shortcutSave',
          label: shortcutLabel(pendingShortcut),
          ...pendingShortcut,
        });
    };
    refreshIcons();
    if (focus === 'shortcut')
      requestAnimationFrame(() =>
        document.querySelector('#shortcut-listen')?.focus({ preventScroll: true }),
      );
  }
  return { close: () => activeShortcutCapture?.(), install };
}
