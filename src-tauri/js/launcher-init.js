// Habibi launcher bridge (injected before the page's own scripts).
//
// The UI was written for a WKWebView hosted by the Swift app with a loopback
// Node service. This keeps that contract working inside Tauri:
//   - same-origin fetch('/api/...') goes to the `api` command (binary-safe);
//   - window.webkit.messageHandlers.habibiNative.postMessage(...) goes to the
//     `native_message` command;
//   - native -> UI callbacks (window.__habibi...) are called by the shell.
(() => {
  'use strict';
  if (window.__habibiBridgeInstalled) return;
  window.__habibiBridgeInstalled = true;
  window.__habibiPlatform = '__HABIBI_PLATFORM__';

  const internals = () => window.__TAURI_INTERNALS__;
  const invoke = (cmd, args, options) => {
    const tauri = internals();
    if (!tauri) return Promise.reject(new Error('Habibi bridge unavailable'));
    return tauri.invoke(cmd, args, options);
  };

  // --- fetch('/api/...') --------------------------------------------------
  const nativeFetch = window.fetch.bind(window);
  const apiTarget = (input) => {
    try {
      const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
      const url = new URL(raw, window.location.href);
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return null;
      return url.pathname + url.search;
    } catch (_) {
      return null;
    }
  };
  const toBytes = (raw) => {
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (Array.isArray(raw)) return Uint8Array.from(raw);
    return new Uint8Array();
  };
  const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

  window.fetch = async function habibiFetch(input, init) {
    const target = apiTarget(input);
    if (!target) return nativeFetch(input, init);
    const fromRequest = input instanceof Request;
    const method = String(init?.method || (fromRequest ? input.method : 'GET')).toUpperCase();
    const signal = init?.signal || (fromRequest ? input.signal : undefined);
    if (signal?.aborted) throw abortError();
    let body = new Uint8Array();
    if (method !== 'GET' && method !== 'HEAD') {
      // Response normalizes every BodyInit (string, Blob, FormData, buffers).
      if (init?.body != null) body = new Uint8Array(await new Response(init.body).arrayBuffer());
      else if (fromRequest) body = new Uint8Array(await input.clone().arrayBuffer());
    }
    const call = invoke('api', body, { headers: { 'x-habibi-method': method, 'x-habibi-path': target } });
    const raw = await (signal
      ? Promise.race([
          call,
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true })),
        ])
      : call);
    const bytes = toBytes(raw);
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
    const headers = new Headers();
    for (const [name, value] of meta.headers || []) headers.append(name, value);
    const status = Number(meta.status) || 200;
    const nullBody = method === 'HEAD' || status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : bytes.slice(4 + length), { status, headers });
  };

  // --- window.webkit.messageHandlers.habibiNative -------------------------
  let topZone = null;
  const habibiNative = Object.freeze({
    postMessage(message) {
      // Plain data only, as WKScriptMessage bodies were.
      let value;
      try {
        value = JSON.parse(JSON.stringify(message ?? null));
      } catch (_) {
        return;
      }
      if (value && value.type === 'dragZones') {
        if (topZone) topZone.style.display = value.headerVisible === false ? 'none' : 'block';
        return;
      }
      invoke('native_message', { message: value }).catch(() => {});
    },
  });
  const existing = window.webkit?.messageHandlers;
  let installed = false;
  if (existing) {
    try {
      Object.defineProperty(existing, 'habibiNative', { value: habibiNative, configurable: true });
      installed = existing.habibiNative === habibiNative;
    } catch (_) {
      installed = false;
    }
  }
  if (!installed) {
    const handlers = new Proxy(
      { habibiNative },
      { get: (target, name) => (name in target ? target[name] : existing?.[name]) },
    );
    const webkit = { messageHandlers: handlers };
    try {
      Object.defineProperty(window, 'webkit', { value: webkit, configurable: true, writable: true });
    } catch (_) {
      window.webkit = webkit;
    }
  }

  // --- window drag zones --------------------------------------------------
  // Dragging is handled by two thin edge strips, not by the page, so every
  // pixel from the search row through the results stays selectable.
  const zone = (edge) => {
    const element = document.createElement('div');
    element.setAttribute('aria-hidden', 'true');
    element.dataset.habibiDragZone = edge;
    Object.assign(element.style, {
      position: 'fixed',
      left: '76px',
      right: '0',
      height: '7px',
      [edge]: '0',
      zIndex: '2147483647',
      background: 'transparent',
    });
    element.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      invoke('native_message', { message: { type: 'windowDrag' } }).catch(() => {});
    });
    document.documentElement.append(element);
    return element;
  };
  const installZones = () => {
    topZone = zone('top');
    zone('bottom');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installZones, { once: true });
  else installZones();
})();
