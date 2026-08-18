import { categorizeError, renderFailure } from '../../core/failure-view.js';
import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';
import { loadingSkeleton } from '../../ui/loading-view.js';

/** Owns Agent Dock discovery, transcripts, and interactive PTY lifecycle. */
export function createAgentSessionsFeature({ input, defaultView, resultsView, count, notify, onBack, onOpen }) {
  let terminal = null;
  let socket = null;
  let resizeObserver = null;
  let terminalAssetsPromise = null;
  let searchTimer = null;
  const find = selector => resultsView.querySelector(selector);

  function close() {
    clearTimeout(searchTimer); searchTimer = null;
    resizeObserver?.disconnect(); resizeObserver = null;
    socket?.close(); socket = null;
    terminal?.dispose(); terminal = null;
  }

  function showSessions(kind = '') {
    close(); onOpen();
    input.value = ''; input.placeholder = kind ? `Filter ${kind === 'codex' ? 'Codex' : 'Claude Code'} sessions…` : 'Filter Codex and Claude sessions…';
    defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = `${kind ? (kind === 'codex' ? 'Codex' : 'Claude Code') : 'Agent'} sessions · local`;
    setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-agent-dock">${icon('arrow-left')} Habibi</button><span class="verified">● local transcripts</span></div><section class="agent-sessions-plugin"><div class="agent-sessions-heading"><span class="icon agents">${icon(kind === 'claude' ? 'sparkles' : kind === 'codex' ? 'braces' : 'bot')}</span><span><b>${kind === 'claude' ? 'Claude Code' : kind === 'codex' ? 'Codex' : 'Codex & Claude Code'}</b><small>Local sessions, transcripts, and exact-session resume. Nothing is uploaded.</small></span></div><div class="agent-session-tabs"><button class="${!kind ? 'selected' : ''}" data-agent-session-kind="">All</button><button class="${kind === 'codex' ? 'selected' : ''}" data-agent-session-kind="codex">Codex</button><button class="${kind === 'claude' ? 'selected' : ''}" data-agent-session-kind="claude">Claude</button></div><div id="agent-dock" class="agent-dock">${loadingSkeleton('Reading local sessions', 'Scanning Codex and Claude Code transcript indexes.')}</div></section>`);
    find('#back-agent-dock').onclick = onBack;
    const load = query => fetch(`/api/agent-sessions?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(query || '')}`).then(response => response.json()).then(data => {
      const dock = find('#agent-dock'); if (!dock) return;
      if (!data.ok) throw new Error('Unavailable');
      if (!data.sessions.length) setHtml(dock, `<div class="clear-day"><span class="icon agents">${icon('bot')}</span><span><b>No matching local sessions.</b><small>Habibi reads the local Codex and Claude Code transcript stores only.</small></span></div>`);
      else {
        setHtml(dock, data.sessions.map((session, index) => `<button class="agent-session ${index === 0 ? 'selected' : ''}" data-agent-session="${encodeURIComponent(JSON.stringify(session))}"><span class="icon agents">${icon(session.kind === 'claude' ? 'sparkles' : 'braces')}</span><span><b>${escapeHtml(session.title)}</b><small>${session.kind === 'claude' ? 'Claude Code' : 'Codex'} · ${new Date(session.updatedAt).toLocaleString()}</small><code>${escapeHtml(session.cwd || 'Project directory unavailable')}</code></span><i data-lucide="chevron-right"></i></button>`).join(''));
        dock.querySelectorAll('[data-agent-session]').forEach(button => button.onclick = () => showSessionDetail(JSON.parse(decodeURIComponent(button.dataset.agentSession))));
      }
      refreshIcons();
    }).catch(() => { const dock = find('#agent-dock'); if (dock) setHtml(dock, '<div class="searching-local">Local agent sessions are unavailable right now.</div>'); });
    resultsView.querySelectorAll('[data-agent-session-kind]').forEach(button => button.onclick = () => showSessions(button.dataset.agentSessionKind));
    load();
    input.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => load(input.value), 180); };
    requestAnimationFrame(() => input.focus({ preventScroll:true }));
  }

  async function showSessionDetail(session) {
    const label = session.kind === 'claude' ? 'Claude Code' : 'Codex';
    setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-agent-session">${icon('arrow-left')} ${label} sessions</button><span class="verified">● local transcript</span></div><section class="agent-transcript"><div class="loading-state"><span class="spinner"></span> Reading this local session…</div></section>`);
    find('#back-agent-session').onclick = () => showSessions(session.kind);
    try {
      const response = await fetch('/api/agent-sessions/detail', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ id:session.id, kind:session.kind }) });
      const data = await response.json(); if (!data.ok) throw new Error(data.error || 'Could not read this session.');
      const transcript = data.transcript || [];
      setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-agent-session">${icon('arrow-left')} ${label} sessions</button><span class="verified">● local transcript</span></div><section class="agent-transcript"><header><span class="icon agents">${icon(session.kind === 'claude' ? 'sparkles' : 'braces')}</span><span><b>${escapeHtml(data.session.title)}</b><small>${escapeHtml(data.session.cwd || 'Project directory unavailable')} · ${new Date(data.session.updatedAt).toLocaleString()}</small></span><button class="primary" id="resume-specific-session">${icon('terminal-square')} Resume <kbd>↵</kbd></button></header><p class="agent-disclaimer">Starts a Habibi-owned local PTY in this project, then opens the ${label} resume picker. Your input and output stay on this Mac.</p><div class="agent-transcript-scroll">${transcript.map(entry => `<article class="agent-transcript-entry ${escapeHtml(entry.role)}"><small>${entry.role === 'tool' ? 'Tool' : entry.role === 'assistant' ? label : 'You'}${entry.at ? ` · ${new Date(entry.at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}` : ''}</small><pre>${escapeHtml(entry.text)}</pre></article>`).join('') || '<div class="local-files-empty">No readable messages in this session.</div>'}</div></section>`);
      find('#back-agent-session').onclick = () => showSessions(session.kind);
      find('#resume-specific-session').onclick = () => showTerminal({ cwd:data.session.cwd, sessionId:data.session.id }, session.kind, label);
      refreshIcons();
    } catch (error) { renderFailure(resultsView, error, { fallback:'Could not read this local session.', retry:() => showSessionDetail(session) }); }
  }

  function showDetail(agent) {
    const kind = /claude/i.test(agent.command) ? 'claude' : 'codex'; const label = kind === 'claude' ? 'Claude Code' : 'Codex';
    setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-agents">${icon('arrow-left')} Agent Dock</button><span class="verified">● running locally</span></div><section class="agent-detail"><div class="agent-detail-title"><span class="icon agents">${icon('bot')}</span><span><b>${escapeHtml(label)}</b><small>PID ${escapeHtml(agent.pid)} · active for ${escapeHtml(agent.elapsed)}</small></span></div><div class="agent-context"><span>PROJECT</span><code>${escapeHtml(agent.cwd || 'Project directory unavailable')}</code></div><div class="agent-context"><span>COMMAND</span><code>${escapeHtml(agent.command)}</code></div><div class="agent-detail-actions"><button class="secondary" id="open-project">${icon('folder-open')} Open project</button><button class="primary" id="resume-agent">${icon('terminal-square')} Open interactive session</button></div><p class="agent-disclaimer">Starts a Habibi-owned local PTY in this project, then opens the ${label} resume picker. Your input and output stay on this Mac.</p></section>`);
    find('#back-agents').onclick = () => showSessions();
    const run = async (endpoint, success) => {
      if (!agent.cwd) return notify('Project directory is unavailable for this process');
      const response = await fetch(endpoint, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ cwd:agent.cwd, kind }) });
      const result = await response.json(); notify(result.ok ? success : 'Could not open the local project');
    };
    find('#open-project').onclick = () => run('/api/agents/open-project', 'Opened project in Finder');
    find('#resume-agent').onclick = () => agent.cwd ? showTerminal(agent, kind, label) : notify('Project directory is unavailable for this process');
    refreshIcons();
  }

  function loadTerminalAsset(tag, attributes) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`[data-habibi-terminal-asset="${attributes.href || attributes.src}"]`);
      if (existing) { if (existing.dataset.loaded === 'true') resolve(); else { existing.addEventListener('load', resolve, { once:true }); existing.addEventListener('error', reject, { once:true }); } return; }
      const element = document.createElement(tag); Object.assign(element, attributes); element.dataset.habibiTerminalAsset = attributes.href || attributes.src;
      element.addEventListener('load', () => { element.dataset.loaded = 'true'; resolve(); }, { once:true });
      element.addEventListener('error', () => reject(new Error('Terminal renderer unavailable.')), { once:true }); document.head.append(element);
    });
  }

  function ensureTerminalAssets() {
    if (window.Terminal && window.FitAddon) return Promise.resolve();
    if (terminalAssetsPromise) return terminalAssetsPromise;
    const styles = loadTerminalAsset('link', { rel:'stylesheet', href:'/vendor/xterm.css' });
    terminalAssetsPromise = Promise.all([styles, loadTerminalAsset('script', { src:'/vendor/xterm.js' })]).then(() => loadTerminalAsset('script', { src:'/vendor/xterm-fit.js' })).then(() => { if (!window.Terminal || !window.FitAddon) throw new Error('Terminal renderer unavailable.'); }).catch(error => { terminalAssetsPromise = null; throw error; });
    return terminalAssetsPromise;
  }

  async function showTerminal(agent, kind, label) {
    close();
    setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-agent-detail">${icon('arrow-left')} ${label}</button><span class="verified">● interactive local PTY</span></div><section class="terminal-shell"><header><span>${icon('terminal-square')} ${escapeHtml(label)} · ${escapeHtml(agent.cwd)}</span><button id="close-terminal">End session</button></header><div id="terminal-host" aria-label="Interactive ${label} terminal"></div><footer><span>Type normally. <kbd>ctrl c</kbd> interrupts · session ends when you close it.</span><span id="terminal-status">Connecting…</span><button type="button" class="link-button" id="resume-again-terminal" hidden>Resume again</button></footer></section>`);
    find('#back-agent-detail').onclick = () => { close(); showDetail(agent); }; find('#close-terminal').onclick = () => { close(); showDetail(agent); }; find('#resume-again-terminal').onclick = () => showTerminal(agent, kind, label);
    const host = find('#terminal-host'); host.textContent = 'Loading terminal renderer…'; refreshIcons();
    try { await ensureTerminalAssets(); } catch (error) { if (!host.isConnected) return; setHtml(host, `<div class="local-files-empty">${escapeHtml(categorizeError(error, 'Terminal renderer unavailable.'))}<button type="button" class="link-button" id="retry-terminal-assets">Try again</button></div>`); find('#retry-terminal-assets')?.addEventListener('click', () => showTerminal(agent, kind, label)); return; }
    if (!host.isConnected) return; host.textContent = '';
    terminal = new window.Terminal({ cursorBlink:true, fontFamily:'"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace', fontSize:12, theme:{ background:'#162B4A', foreground:'#FAF5EC', cursor:'#F4781C', selectionBackground:'#1C3B6D' } });
    const fit = new window.FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open(host); fit.fit();
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'; socket = new WebSocket(`${protocol}://${window.location.host}/pty`);
    const resize = () => { if (!socket || socket.readyState !== WebSocket.OPEN) return; fit.fit(); socket.send(JSON.stringify({ type:'resize', cols:terminal.cols, rows:terminal.rows })); };
    resizeObserver = new ResizeObserver(resize); resizeObserver.observe(host);
    socket.onopen = () => { socket.send(JSON.stringify({ type:'start', cwd:agent.cwd, kind, sessionId:agent.sessionId || '' })); resize(); };
    socket.onmessage = event => { const message = JSON.parse(event.data); if (message.type === 'data') terminal.write(message.data); if (message.type === 'started') find('#terminal-status').textContent = 'Running'; if (message.type === 'exit') { find('#terminal-status').textContent = `Exited (${message.exitCode})`; find('#resume-again-terminal')?.removeAttribute('hidden'); } if (message.type === 'error') terminal.write(`\r\nError: ${message.message}\r\n`); };
    socket.onclose = () => { const status = find('#terminal-status'); if (status?.textContent === 'Connecting…') { status.textContent = 'Disconnected'; find('#resume-again-terminal')?.removeAttribute('hidden'); } };
    terminal.onData(data => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type:'input', data }))); setTimeout(() => { resize(); terminal.focus(); }, 50);
  }

  return { close, showDetail, showDock:() => showSessions(), showSessions };
}
