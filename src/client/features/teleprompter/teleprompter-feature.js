import { setHtml } from '../../core/safe-dom.js';
import { icon, refreshIcons } from '../../core/view-helpers.js';

const key = 'habibi.teleprompter.v1';
const maxLength = 100_000;

/** Script editing stays local; AppKit owns the separate, low-overhead overlay. */
export function createTeleprompterFeature({ input, defaultView, resultsView, count, notify, onBack, onOpen }) {
  let state = { state: 'stopped', visible: false };
  const bridge = () => window.webkit?.messageHandlers?.habibiNative;
  window.__habibiTeleprompterState = value => {
    if (value?.error) return notify(value.error);
    state = { ...state, ...value };
    renderState();
  };
  function renderState() {
    const page = resultsView.querySelector('.teleprompter-workspace');
    if (!page) return;
    const running = state.state === 'running';
    page.querySelector('#teleprompter-state').textContent = state.visible ? running ? 'Reading' : state.state === 'finished' ? 'End of script' : 'Paused' : 'Ready';
    page.querySelector('#teleprompter-toggle').textContent = running ? 'Pause' : 'Resume';
    for (const id of ['teleprompter-toggle', 'teleprompter-stop', 'teleprompter-reset']) page.querySelector(`#${id}`).disabled = !state.visible;
  }
  function show() {
    onOpen();
    input.value = '';
    input.placeholder = 'Search anything, or ask Habibi…';
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = 'Teleprompter · on this Mac';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { /* Start with an empty editor. */ }
    setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-teleprompter">${icon('arrow-left')} Habibi</button><span class="verified">● local script</span></div>
      <section class="teleprompter-workspace" aria-labelledby="teleprompter-heading">
        <header class="teleprompter-heading"><span><h2 id="teleprompter-heading">Teleprompter</h2><p>Your words, just below the camera.</p></span><span class="status-pill" id="teleprompter-state">Ready</span></header>
        <div class="teleprompter-preview" aria-hidden="true"><span class="teleprompter-notch"></span><p>Stay present.<br><strong>Let your words come to you.</strong></p><small>TOP OF YOUR DISPLAY</small></div>
        <div class="teleprompter-editor"><label for="teleprompter-script">Your script <span id="teleprompter-count">0 words</span></label><textarea id="teleprompter-script" maxlength="100000" placeholder="Paste your script here…" spellcheck="true"></textarea></div>
        <div class="teleprompter-options"><label for="teleprompter-pace">Reading pace <output id="teleprompter-pace-label"></output><input type="range" id="teleprompter-pace" min="60" max="260" step="10" /></label><label for="teleprompter-font">Text size <output id="teleprompter-font-label"></output><input type="range" id="teleprompter-font" min="16" max="40" step="2" /></label><label for="teleprompter-width">Overlay width<select id="teleprompter-width"><option value="460">Compact</option><option value="620">Comfortable</option><option value="800">Wide</option></select></label></div>
        <footer class="teleprompter-footer"><p id="teleprompter-help">Drag the overlay to move it. Space pauses; Esc closes it when focused.</p><div class="teleprompter-actions"><button class="secondary" id="teleprompter-reset" disabled>Restart</button><button class="secondary" id="teleprompter-toggle" disabled>Resume</button><button class="secondary" id="teleprompter-stop" disabled>Close overlay</button><button class="primary" id="teleprompter-start">${icon('radio')} Start <kbd>⌘ ↵</kbd></button></div></footer>
      </section>`);
    const page = resultsView.querySelector('.teleprompter-workspace');
    const script = page.querySelector('#teleprompter-script');
    const pace = page.querySelector('#teleprompter-pace');
    const font = page.querySelector('#teleprompter-font');
    const width = page.querySelector('#teleprompter-width');
    script.value = typeof saved.script === 'string' ? saved.script.slice(0, maxLength) : '';
    pace.value = Number.isFinite(saved.pace) ? saved.pace : 140;
    font.value = Number.isFinite(saved.fontSize) ? saved.fontSize : 24;
    width.value = [460, 620, 800].includes(saved.width) ? saved.width : 620;
    const configuration = () => ({ pace: Number(pace.value), fontSize: Number(font.value), width: Number(width.value) });
    const update = () => {
      const words = script.value.trim().split(/\s+/).filter(Boolean).length;
      const seconds = Math.ceil(words / Number(pace.value) * 60);
      const duration = seconds < 60 ? `${seconds} sec` : `${Math.ceil(seconds / 60)} min`;
      page.querySelector('#teleprompter-count').textContent = `${words} word${words === 1 ? '' : 's'}${words ? ` · ~${duration}` : ''}`;
      page.querySelector('#teleprompter-pace-label').textContent = `${pace.value} wpm`;
      page.querySelector('#teleprompter-font-label').textContent = `${font.value} pt`;
      page.querySelector('#teleprompter-start').disabled = !script.value.trim();
      try { localStorage.setItem(key, JSON.stringify({ script: script.value, ...configuration() })); } catch { /* Reading still works when storage is full. */ }
    };
    script.oninput = update;
    for (const control of [pace, font, width]) {
      control.oninput = update;
      control.onchange = () => { update(); bridge()?.postMessage({ type: 'teleprompter', action: 'configure', ...configuration() }); };
    }
    page.querySelector('#teleprompter-start').onclick = () => {
      if (!script.value.trim()) return;
      if (!bridge()) return notify('Open Habibi.app to show the floating teleprompter.');
      bridge().postMessage({ type: 'teleprompter', action: 'start', script: script.value, ...configuration() });
    };
    for (const [id, action] of [['teleprompter-stop', 'stop'], ['teleprompter-reset', 'reset']]) page.querySelector(`#${id}`).onclick = () => bridge()?.postMessage({ type: 'teleprompter', action });
    page.querySelector('#teleprompter-toggle').onclick = () => bridge()?.postMessage({ type: 'teleprompter', action: state.state === 'running' ? 'pause' : 'resume' });
    resultsView.querySelector('#back-teleprompter').onclick = onBack;
    page.addEventListener('keydown', event => {
      if (event.metaKey && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); page.querySelector('#teleprompter-start').click(); }
    });
    if (!bridge()) page.querySelector('#teleprompter-help').textContent = 'Edit your script here. The floating overlay is available in Habibi.app.';
    update();
    renderState();
    refreshIcons();
    bridge()?.postMessage({ type: 'teleprompter', action: 'state' });
    script.focus();
  }
  return { show };
}
