import { thisDevice } from '../../core/platform-copy.js';
import { primaryModifier, primaryEnterLabel } from '../../core/primary-modifier.js';
import { setHtml } from '../../core/safe-dom.js';
import { icon, refreshIcons } from '../../core/view-helpers.js';
import { updateTeleprompterRange } from './teleprompter-controls.js';

const key = 'habibi.teleprompter.v1';
const maxLength = 100_000;
const exampleScript = `Hello, and welcome. This is a short test of the teleprompter.

I can look toward the camera, take a breath, and speak at my own pace. There is no need to rush.

Now I will pause for a moment. When I start speaking again, the words should follow me.

A clear message starts with one simple idea. Today, that idea is to stay present, speak naturally, and let each sentence land.

I can slow down for an important point, then continue with a little more energy. The script stays close to the camera, so I can keep my eyes up.

And that is the end of the test. Ready when you are.`;

/** Script editing stays local; AppKit owns the separate, low-overhead overlay. */
export function createTeleprompterFeature({ input, defaultView, resultsView, count, notify, onBack, onOpen }) {
  let state = { state: 'stopped', visible: false };
  const bridge = () => window.webkit?.messageHandlers?.habibiNative;
  window.__habibiTeleprompterState = value => {
    if (value?.error) notify(value.error);
    state = { ...state, ...value };
    renderState();
  };
  function renderState() {
    const page = resultsView.querySelector('.teleprompter-workspace');
    if (!page) return;
    const running = state.state === 'running';
    page.querySelector('#teleprompter-state').textContent = state.visible ? running ? state.mode === 'voice' ? 'Listening' : 'Reading' : state.state === 'finished' ? 'End of script' : 'Paused' : 'Ready';
    page.querySelector('.teleprompter-live-controls').hidden = !state.visible;
    page.querySelector('#teleprompter-toggle').textContent = running ? 'Pause' : 'Resume';
    for (const id of ['teleprompter-toggle', 'teleprompter-stop', 'teleprompter-reset']) page.querySelector(`#${id}`).disabled = !state.visible;
  }
  function show() {
    onOpen();
    input.value = '';
    input.placeholder = 'Search anything, or ask Habibi…';
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = `Teleprompter · on ${thisDevice()}`;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { /* Start with an empty editor. */ }
    setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-teleprompter">${icon('arrow-left')} Habibi</button><span class="verified">● local script</span></div>
      <section class="teleprompter-workspace" aria-labelledby="teleprompter-heading">
        <header class="teleprompter-heading"><span><h2 id="teleprompter-heading">Teleprompter</h2><p>Your words, just below the camera.</p></span><span class="status-pill" id="teleprompter-state">Ready</span></header>
        <div class="teleprompter-preview" aria-hidden="true"><span class="teleprompter-notch"></span><p>Stay present.<br><strong>Let your words come to you.</strong></p><small>TOP OF YOUR DISPLAY</small></div>
        <div class="teleprompter-editor"><div class="teleprompter-editor-heading"><label for="teleprompter-script">Your script</label><span><span id="teleprompter-count">0 words</span><button type="button" id="teleprompter-example">Load example</button></span></div><textarea id="teleprompter-script" maxlength="100000" placeholder="Paste your script here…" spellcheck="true"></textarea></div>
        <div class="teleprompter-options"><div class="teleprompter-field"><label id="teleprompter-mode-label" for="teleprompter-mode">Playback</label><select id="teleprompter-mode"><option value="voice">Follow my voice</option><option value="automatic">Automatic scrolling</option></select></div><div class="teleprompter-field"><label for="teleprompter-pace">Scroll speed <output id="teleprompter-pace-label"></output></label><input type="range" id="teleprompter-pace" min="60" max="260" step="10" /></div><div class="teleprompter-field"><label for="teleprompter-font">Text size <output id="teleprompter-font-label"></output></label><input type="range" id="teleprompter-font" min="16" max="40" step="2" /></div><div class="teleprompter-field"><label id="teleprompter-width-label" for="teleprompter-width">Overlay width</label><select id="teleprompter-width"><option value="460">Compact</option><option value="620">Comfortable</option><option value="800">Wide</option></select></div></div>
        <footer class="teleprompter-footer"><p id="teleprompter-help">Follows your voice on ${thisDevice()}. Microphone access is requested when you start.</p><div class="teleprompter-actions"><span class="teleprompter-live-controls" hidden><button class="secondary" id="teleprompter-reset" disabled>Restart</button><button class="secondary" id="teleprompter-toggle" disabled>Resume</button><button class="secondary" id="teleprompter-stop" disabled>Close overlay</button></span><button class="primary" id="teleprompter-start">${icon('radio')} Start <kbd>${primaryEnterLabel()}</kbd></button></div></footer>
      </section>`);
    const page = resultsView.querySelector('.teleprompter-workspace');
    const script = page.querySelector('#teleprompter-script');
    const mode = page.querySelector('#teleprompter-mode');
    const pace = page.querySelector('#teleprompter-pace');
    const font = page.querySelector('#teleprompter-font');
    const width = page.querySelector('#teleprompter-width');
    script.value = typeof saved.script === 'string' && saved.script.trim() ? saved.script.slice(0, maxLength) : exampleScript;
    mode.value = saved.mode === 'automatic' ? 'automatic' : 'voice';
    pace.value = Number.isFinite(saved.pace) ? saved.pace : 140;
    font.value = Number.isFinite(saved.fontSize) ? saved.fontSize : 24;
    width.value = [460, 620, 800].includes(saved.width) ? saved.width : 620;
    const configuration = () => ({ mode: mode.value, pace: Number(pace.value), fontSize: Number(font.value), width: Number(width.value) });
    const update = () => {
      const words = script.value.trim().split(/\s+/).filter(Boolean).length;
      const seconds = Math.ceil(words / Number(pace.value) * 60);
      const duration = seconds < 60 ? `${seconds} sec` : `${Math.ceil(seconds / 60)} min`;
      page.querySelector('#teleprompter-count').textContent = `${words} word${words === 1 ? '' : 's'}${words ? ` · ~${duration}` : ''}`;
      page.querySelector('#teleprompter-pace-label').textContent = `${pace.value} wpm`;
      page.querySelector('#teleprompter-font-label').textContent = `${font.value} pt`;
      updateTeleprompterRange(pace, page.querySelector('#teleprompter-pace-label'));
      updateTeleprompterRange(font, page.querySelector('#teleprompter-font-label'));
      if (bridge()) page.querySelector('#teleprompter-help').textContent = mode.value === 'voice' ? `Follows your voice on ${thisDevice()}. Microphone access is requested when you start.` : 'Scrolls at your chosen pace. Space pauses; Esc closes the overlay.';
      page.querySelector('#teleprompter-start').disabled = !script.value.trim();
      try { localStorage.setItem(key, JSON.stringify({ script: script.value, ...configuration() })); } catch { /* Reading still works when storage is full. */ }
    };
    script.oninput = update;
    page.querySelector('#teleprompter-example').onclick = () => {
      script.value = exampleScript;
      update();
      script.focus();
      script.setSelectionRange(0, 0);
      script.scrollTop = 0;
    };
    for (const control of [mode, pace, font, width]) {
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
      if (primaryModifier(event) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); page.querySelector('#teleprompter-start').click(); }
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
