import { categorizeError } from '../../core/failure-view.js';
import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';

export function createTerminalController({ resultsView, find, showDetail }) {
  let terminal = null;
  let socket = null;
  let resizeObserver = null;
  let terminalAssetsPromise = null;

  function close() {
    resizeObserver?.disconnect();
    resizeObserver = null;
    socket?.close();
    socket = null;
    terminal?.dispose();
    terminal = null;
  }

  function loadTerminalAsset(tag, attributes) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(
        `[data-habibi-terminal-asset="${attributes.href || attributes.src}"]`,
      );
      if (existing) {
        if (existing.dataset.loaded === 'true') resolve();
        else {
          existing.addEventListener('load', resolve, { once: true });
          existing.addEventListener('error', reject, { once: true });
        }
        return;
      }
      const element = document.createElement(tag);
      Object.assign(element, attributes);
      element.dataset.habibiTerminalAsset = attributes.href || attributes.src;
      element.addEventListener(
        'load',
        () => {
          element.dataset.loaded = 'true';
          resolve();
        },
        { once: true },
      );
      element.addEventListener('error', () => reject(new Error('Terminal renderer unavailable.')), {
        once: true,
      });
      document.head.append(element);
    });
  }

  function ensureTerminalAssets() {
    if (window.Terminal && window.FitAddon) return Promise.resolve();
    if (terminalAssetsPromise) return terminalAssetsPromise;
    const styles = loadTerminalAsset('link', { rel: 'stylesheet', href: '/vendor/xterm.css' });
    terminalAssetsPromise = Promise.all([
      styles,
      loadTerminalAsset('script', { src: '/vendor/xterm.js' }),
    ])
      .then(() => loadTerminalAsset('script', { src: '/vendor/xterm-fit.js' }))
      .then(() => {
        if (!window.Terminal || !window.FitAddon) throw new Error('Terminal renderer unavailable.');
      })
      .catch((error) => {
        terminalAssetsPromise = null;
        throw error;
      });
    return terminalAssetsPromise;
  }

  async function showTerminal(agent, kind, label) {
    close();
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-agent-detail">${icon('arrow-left')} ${label}</button><span class="verified">● interactive local PTY</span></div><section class="terminal-shell"><header><span>${icon('terminal-square')} ${escapeHtml(label)} · ${escapeHtml(agent.cwd)}</span><button id="close-terminal">End session</button></header><div id="terminal-host" aria-label="Interactive ${label} terminal"></div><footer><span>Type normally. <kbd>ctrl c</kbd> interrupts · session ends when you close it.</span><span id="terminal-status">Connecting…</span><button type="button" class="link-button" id="resume-again-terminal" hidden>Resume again</button></footer></section>`,
    );
    find('#back-agent-detail').onclick = () => {
      close();
      showDetail(agent);
    };
    find('#close-terminal').onclick = () => {
      close();
      showDetail(agent);
    };
    find('#resume-again-terminal').onclick = () => showTerminal(agent, kind, label);
    const host = find('#terminal-host');
    host.textContent = 'Loading terminal renderer…';
    refreshIcons();
    try {
      await ensureTerminalAssets();
    } catch (error) {
      if (!host.isConnected) return;
      setHtml(
        host,
        `<div class="local-files-empty">${escapeHtml(categorizeError(error, 'Terminal renderer unavailable.'))}<button type="button" class="link-button" id="retry-terminal-assets">Try again</button></div>`,
      );
      find('#retry-terminal-assets')?.addEventListener('click', () =>
        showTerminal(agent, kind, label),
      );
      return;
    }
    if (!host.isConnected) return;
    host.textContent = '';
    terminal = new window.Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      theme: {
        background: '#162B4A',
        foreground: '#FAF5EC',
        cursor: '#F4781C',
        selectionBackground: '#1C3B6D',
      },
    });
    const fit = new window.FitAddon.FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${window.location.host}/pty`);
    const resize = () => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      fit.fit();
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    };
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    socket.onopen = () => {
      socket.send(
        JSON.stringify({ type: 'start', cwd: agent.cwd, kind, sessionId: agent.sessionId || '' }),
      );
      resize();
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'data') terminal.write(message.data);
      if (message.type === 'started') find('#terminal-status').textContent = 'Running';
      if (message.type === 'exit') {
        find('#terminal-status').textContent = `Exited (${message.exitCode})`;
        find('#resume-again-terminal')?.removeAttribute('hidden');
      }
      if (message.type === 'error') terminal.write(`\r\nError: ${message.message}\r\n`);
    };
    socket.onclose = () => {
      const status = find('#terminal-status');
      if (status?.textContent === 'Connecting…') {
        status.textContent = 'Disconnected';
        find('#resume-again-terminal')?.removeAttribute('hidden');
      }
    };
    terminal.onData(
      (data) =>
        socket?.readyState === WebSocket.OPEN &&
        socket.send(JSON.stringify({ type: 'input', data })),
    );
    setTimeout(() => {
      resize();
      terminal.focus();
    }, 50);
  }

  return { close, showTerminal };
}
