// Habibi overlay bridge (teleprompter / focus timer pages).
// Defines window.webkit.messageHandlers.__HABIBI_HANDLER__ for the page and
// forwards its { action } messages (plus the teleprompter's measured
// { action: 'layout', layout }) to the `overlay_message` command.
(() => {
  'use strict';
  if (window.__habibiOverlayBridgeInstalled) return;
  window.__habibiOverlayBridgeInstalled = true;
  const send = (action, layout) => {
    const tauri = window.__TAURI_INTERNALS__;
    if (!tauri || typeof action !== 'string') return;
    const message = { action };
    if (action === 'layout') {
      try {
        message.layout = JSON.parse(JSON.stringify(layout ?? null));
      } catch (_) {
        return;
      }
    }
    tauri.invoke('overlay_message', { message }).catch(() => {});
  };
  const handler = Object.freeze({ postMessage: (message) => send(message?.action, message?.layout) });
  const existing = window.webkit?.messageHandlers;
  let installed = false;
  if (existing) {
    try {
      Object.defineProperty(existing, '__HABIBI_HANDLER__', { value: handler, configurable: true });
      installed = existing.__HABIBI_HANDLER__ === handler;
    } catch (_) {
      installed = false;
    }
  }
  if (!installed) {
    const handlers = new Proxy(
      { __HABIBI_HANDLER__: handler },
      { get: (target, name) => (name in target ? target[name] : existing?.[name]) },
    );
    const webkit = { messageHandlers: handlers };
    try {
      Object.defineProperty(window, 'webkit', { value: webkit, configurable: true, writable: true });
    } catch (_) {
      window.webkit = webkit;
    }
  }
  // The teleprompter answers Space (pause/resume) and Esc (close) while it
  // has focus, as the Swift panel did.
  if (__HABIBI_READING_KEYS__) {
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.metaKey || event.altKey || event.ctrlKey) return;
        if (event.code === 'Space') {
          event.preventDefault();
          if (!event.repeat) send('toggle');
        } else if (event.key === 'Escape') {
          event.preventDefault();
          send('stop');
        }
      },
      true,
    );
  }
})();
