import { chatTime, escapeHtml, icon, initials, refreshIcons, safeImageSrc, safeMediaSrc } from './src/client/core/view-helpers.js';
import { replaceHtml, setHtml } from './src/client/core/safe-dom.js';
import { launcherResults } from './src/client/data/launcher-results.js';
import { createResultButton } from './src/client/ui/result-button.js';
import { createSearchFeature } from './src/client/features/search/search-feature.js';
import { renderAssistantMarkdown } from './src/client/core/query.js';
import { llmProviders } from './src/client/features/llm/provider-catalog.js';
import { calendarDraftFromText } from './src/client/features/calendar/event-intent.js';
import { createKeyboardController } from './src/client/core/keyboard-controller.js';
import { analyticsEnabled, countBucket, lengthBucket, setAnalyticsEnabled, track } from './src/client/core/analytics.js';

const input = document.querySelector('#command-input');
const defaultView = document.querySelector('#default-view');
const resultsView = document.querySelector('#results-view');
const count = document.querySelector('#result-count');
const updateButton = document.querySelector('#update-available');
let updateState = null;
const toast = document.querySelector('#toast');
const dropDock = document.querySelector('#drop-dock');
let activeTerminal = null;
let activeTerminalSocket = null;
let terminalResizeObserver = null;
let terminalAssetsPromise = null;
let openwaStateKey = null;
let whatsappComponentPromise = null;
let contactSearchSequence = 0;
let launcherMode = null;
let whatsappChats = [];
let localContactNames = new Map();
let localContactsRequested = false;
let runningAppsState = null;
let kubernetesState = { context:'', contexts:[], namespace:'', namespaces:[] };
let kubernetesLogFollowTimer = null;
let kubernetesLogLines = [];
let whatsappSource = null;
let proactiveContext = { events:[], mail:[], provider:'' };
let proactiveLoadedAt = 0;
let proactiveLoadInFlight = null;
const proactiveCacheMs = 60_000;
let mailInboxState = null;
let mailSearchTimer = null;
let mailSearchSequence = 0;
let activeShortcutCapture = null;
let commandSearchTimer = null;
const pastedTextAttachmentThreshold = 50;
const demoScreen = new URLSearchParams(window.location.search).get('demo');
const demoMode = ['briefing', 'search', 'preferences'].includes(demoScreen);
// README captures use the same UI and components as the launcher, simply at
// the roomier desktop width a native panel gets when there is screen space.
// This prevents content-rich views from looking like portrait cards beside a
// compact search result in the project gallery.
if (demoMode) document.documentElement.dataset.demoCapture = 'true';
const demoEvents = [{ id:'demo-aurora-review', title:'Project Aurora review', start:'2026-08-11T10:30:00.000Z', end:'2026-08-11T11:00:00.000Z', calendar:'Work' }];
const demoMail = [
  { id:'demo-aurora-design', accountId:'demo-mail', accountEmail:'you@example.test', subject:'Re: Aurora design review', from:'Maya Chen', timestamp:'2026-08-11T09:16:00.000Z', unread:true },
];
const homeLayoutDefaults = Object.freeze({ header:true, briefing:true, calendar:true, mail:true, suggestions:true, footer:true, focusOnly:false });
const ephemeralHistoryKey = 'habibi.ephemeral-conversation-history.v1';
const onboardingDismissedKey = 'habibi.getting-started.dismissed.v1';
const onboardingShortcutKey = 'habibi.getting-started.shortcut-set.v1';
const onboardingPreviewKey = 'habibi.getting-started.preview.v1';
const iconNames = { whatsapp:'message-circle-more', calendar:'calendar-days', files:'folder', agents:'bot', gmail:'mail', kubernetes:'ship-wheel' };
const results = launcherResults;
const resultButton = createResultButton({ icon, chatTime, iconNames });
const { renderSearch } = createSearchFeature({ input, defaultView, resultsView, count, results, resultButton, refreshIcons });

window.__habibiUpdateState = state => {
  updateState = state || updateState;
  if (!updateButton || !state?.available) return;
  updateButton.classList.remove('hidden');
  setHtml(updateButton, `${icon(['downloading', 'installing'].includes(state.state) ? 'loader-circle' : 'download')} ${escapeHtml(state.state === 'downloading' ? 'Downloading update…' : state.state === 'installing' ? 'Installing update…' : `Update available · ${state.version}`)}`);
  updateButton.disabled = ['downloading', 'installing'].includes(state.state);
  updateButton.onclick = showUpdateDialog;
  const dialog = document.querySelector('#update-dialog');
  if (dialog) updateDialogContent(dialog, state);
  refreshIcons();
};
function updateDialogContent(dialog, state) {
  const installing = ['downloading', 'installing'].includes(state?.state);
  setHtml(dialog, `<section class="update-dialog-card" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title"><span class="icon agents">${icon('download')}</span><div><span class="briefing-heading">HABIBI UPDATE</span><h2 id="update-dialog-title">${installing ? (state.state === 'downloading' ? 'Downloading update…' : 'Installing and restarting…') : `Habibi ${escapeHtml(state?.version || '')} is ready`}</h2><p>${installing ? 'Keep this window open. Habibi will close and reopen automatically.' : 'The signed update will replace this copy of Habibi, then reopen automatically.'}</p></div><div class="update-dialog-actions">${installing ? '<span class="mini-spinner"></span>' : '<button type="button" class="secondary" data-update-later>Later</button><button type="button" class="primary" data-install-update>Install update</button>'}</div></section>`);
  dialog.querySelector('[data-update-later]')?.addEventListener('click', () => dialog.remove());
  dialog.querySelector('[data-install-update]')?.addEventListener('click', () => window.webkit?.messageHandlers?.habibiNative?.postMessage({ type:'installUpdate' }));
  refreshIcons();
}
function showUpdateDialog() {
  if (!updateState?.available || document.querySelector('#update-dialog')) return;
  const dialog = document.createElement('div'); dialog.id = 'update-dialog';
  document.body.append(dialog); updateDialogContent(dialog, updateState);
  dialog.querySelector('[data-install-update]')?.focus();
}
window.__habibiShowUpdateDialog = showUpdateDialog;
window.webkit?.messageHandlers?.habibiNative?.postMessage({ type:'checkForUpdate' });

function homeLayout() { try { return { ...homeLayoutDefaults, ...JSON.parse(localStorage.getItem('habibi.home-layout') || '{}') }; } catch (_) { return { ...homeLayoutDefaults }; } }
function applyHomeLayout() {
  const layout = homeLayout();
  const sections = {
    header:[document.querySelector('.topbar')],
    briefing:[document.querySelector('#proactive-briefing')],
    calendar:[document.querySelector('.agenda-home-header'), document.querySelector('#agenda-glance')],
    mail:[document.querySelector('#proactive-mail')],
    suggestions:[document.querySelector('#quick-samples')],
    footer:[document.querySelector('footer')],
  };
  Object.entries(sections).forEach(([id, nodes]) => nodes.filter(Boolean).forEach(node => node.classList.toggle('home-section-hidden', !layout[id])));
  const hasContext = Boolean(proactiveContext.events?.length || proactiveContext.mail?.length);
  defaultView.classList.toggle('home-focus-only', layout.focusOnly && !hasContext);
  window.webkit?.messageHandlers?.habibiNative?.postMessage({ type:'dragZones', headerVisible:layout.header });
}
function saveHomeLayout(id, visible) { const next = homeLayout(); next[id] = visible; localStorage.setItem('habibi.home-layout', JSON.stringify(next)); applyHomeLayout(); }
function showDefault() { stopKubernetesLogFollow(); clearTimeout(commandSearchTimer); activeShortcutCapture?.(); window.__habibiAttachPastedFiles = null; launcherMode=null; input.placeholder='Search anything, or ask Habibi…'; input.value=''; defaultView.classList.remove('hidden'); resultsView.classList.add('hidden'); count.textContent='6 skills available'; applyHomeLayout(); loadGettingStarted(); loadProactiveHome(); renderQuickSamples(); track('habibi.launcher.opened', { surface:'home', app_type:'native', app_version:'0.1.0' }); }
function reopenGettingStarted() { localStorage.removeItem(onboardingDismissedKey); localStorage.setItem(onboardingPreviewKey, 'true'); showDefault(); }
async function loadGettingStarted() {
  const target = document.querySelector('#getting-started');
  if (!target) return;
  // The README renderer deliberately uses no real connection state.
  if (demoMode) { target.classList.add('hidden'); setHtml(target, ''); return; }
  const preview = localStorage.getItem(onboardingPreviewKey) === 'true';
  if (localStorage.getItem(onboardingDismissedKey) === 'done' && !preview) { target.classList.add('hidden'); setHtml(target, ''); return; }
  target.classList.remove('hidden');
  setHtml(target, '<div class="getting-started-loading"><span class="mini-spinner"></span> Checking your setup…</div>');
  const [mail, whatsapp, llm] = await Promise.all([
    fetch('/api/mail/status').then(response => response.json()).catch(() => ({ accounts:[] })),
    fetch('/api/openwa/status').then(response => response.json()).catch(() => ({ session:null })),
    fetch('/api/llm/status').then(response => response.json()).catch(() => ({ configured:false })),
  ]);
  if (target !== document.querySelector('#getting-started') || localStorage.getItem(onboardingDismissedKey) === 'done') return;
  const steps = [
    { id:'shortcut', icon:'keyboard', title:'Choose your shortcut', detail:'Open Habibi from anywhere', done:Boolean(localStorage.getItem(onboardingShortcutKey)), action:'shortcut', cta:'Set shortcut' },
    { id:'mail', icon:'mail', title:'Connect your mail', detail:'Search and reply from one place', done:(mail.accounts || []).some(account => account.connected), action:'mail', cta:'Connect mail' },
    { id:'whatsapp', icon:'message-circle-more', title:'Connect WhatsApp', detail:'Find chats and draft messages locally', done:whatsapp.session?.status === 'ready', action:'whatsapp', cta:'Connect WhatsApp' },
    { id:'model', icon:'sparkles', title:'Connect a model', detail:'Use local models or your own provider', done:Boolean(llm.configured), action:'model', cta:'Connect model' },
  ];
  if (steps.every(step => step.done) && !preview) { localStorage.setItem(onboardingDismissedKey, 'done'); target.classList.add('hidden'); setHtml(target, ''); return; }
  setHtml(target, `<div class="getting-started-heading"><span><span class="briefing-heading">GETTING STARTED</span><b>Make Habibi yours</b><small>Set up only what you want. You can come back to this any time.</small></span><button type="button" class="getting-started-dismiss" id="dismiss-getting-started">Not now</button></div><div class="getting-started-steps">${steps.map(step => `<button type="button" class="getting-started-step ${step.done ? 'complete' : ''}" data-onboarding-action="${step.action}"><span class="getting-started-icon">${icon(step.done ? 'check' : step.icon)}</span><span><b>${escapeHtml(step.title)}</b><small>${escapeHtml(step.done ? 'Ready' : step.detail)}</small></span><em>${step.done ? 'DONE' : escapeHtml(step.cta)}</em><i>${icon('chevron-right')}</i></button>`).join('')}</div>`);
  document.querySelector('#dismiss-getting-started')?.addEventListener('click', () => { localStorage.setItem(onboardingDismissedKey, 'done'); localStorage.removeItem(onboardingPreviewKey); target.classList.add('hidden'); });
  target.querySelectorAll('[data-onboarding-action]').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.onboardingAction;
    if (action === 'shortcut') return showSettings({ focus:'shortcut' });
    if (action === 'mail') return showMailClient();
    if (action === 'whatsapp') return showChatClient();
    if (action === 'model') return showLlmSetup({ afterConfigured:showDefault });
  }));
  refreshIcons();
}
function dismissLauncher() {
  const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
  if (nativeBridge) nativeBridge.postMessage('dismiss');
  else { showDefault(); input.blur(); }
}
function shouldAttachPastedText(text) { return String(text || '').trim().length > pastedTextAttachmentThreshold; }
const themeCatalog = [
  { id:'deep-ocean', name:'Clidey Ink', description:'Brand navy, lifted blue', swatches:['#0E2240','#2C6BD4','#4787F3'] },
  { id:'midnight-noir', name:'Midnight Noir', description:'OLED black, electric blue', swatches:['#05070b','#111827','#60a5fa'] },
  { id:'aurora-glass', name:'Aurora Glass', description:'Iridescent translucent layers', swatches:['#10223b','#5b5ce2','#c084fc'] },
  { id:'forest-moss', name:'Forest Moss', description:'Deep green and warm moss', swatches:['#0d1914','#274b38','#b7d77b'] },
  { id:'solar-gold', name:'Solar Gold', description:'Dark bronze with bright gold', swatches:['#1b1410','#6f4318','#f6c85f'] },
  { id:'velvet-rose', name:'Velvet Rose', description:'Ink purple and rose glow', swatches:['#1b1023','#713b68','#f0a7c4'] },
  { id:'boring-good', name:'Boring (Compliment)', description:'Clean neutral Shadcn energy', swatches:['#09090b','#27272a','#fafafa'] },
];
const shortcutKeyCodes = { Space:49, Enter:36, Escape:53, Tab:48, Backspace:51, Delete:117, ArrowUp:126, ArrowDown:125, ArrowLeft:123, ArrowRight:124, Home:115, End:119, PageUp:116, PageDown:121 };
'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((letter, index) => { shortcutKeyCodes[`Key${letter}`] = [0,11,8,2,14,3,5,4,34,38,40,37,46,45,31,35,12,15,1,17,32,9,13,7,16,6][index]; });
'0123456789'.split('').forEach((digit, index) => { shortcutKeyCodes[`Digit${digit}`] = [29,18,19,20,21,23,22,26,28,25][index]; });
function applyTheme(theme = localStorage.getItem('habibi.theme') || 'deep-ocean') { const next = theme === 'blue' ? 'deep-ocean' : theme; document.body.dataset.theme = next; localStorage.setItem('habibi.theme', next); }
function applyColorMode(mode = localStorage.getItem('habibi.color-mode') || 'dark') { const next = mode === 'light' ? 'light' : 'dark'; document.body.dataset.colorMode = next; localStorage.setItem('habibi.color-mode', next); }
function shortcutLabel(shortcut) { return `${shortcut.meta ? '⌘ ' : ''}${shortcut.alt ? '⌥ ' : ''}${shortcut.ctrl ? '⌃ ' : ''}${shortcut.shift ? '⇧ ' : ''}${shortcut.key || 'shortcut'}`.trim(); }
function shortcutPayload(event) { const keyCode = shortcutKeyCodes[event.code]; if (keyCode === undefined || (!event.metaKey && !event.altKey && !event.ctrlKey)) return null; return { keyCode, modifiers:(event.metaKey ? 256 : 0) | (event.altKey ? 2048 : 0) | (event.ctrlKey ? 4096 : 0) | (event.shiftKey ? 512 : 0), meta:event.metaKey, alt:event.altKey, ctrl:event.ctrlKey, shift:event.shiftKey, key:event.code === 'Space' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key }; }
async function nativeClipboardImageFiles() {
  const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
  if (!nativeBridge) return [];
  try {
    const payload = await new Promise(resolve => {
      // Kept for browser-initiated fallback only. Native shortcut pastes use
      // the non-expiring push receiver below, because PNG conversion may take
      // several seconds for a large macOS screenshot.
      const timer = setTimeout(() => { window.__habibiClipboardImage = null; resolve({ ok:false }); }, 20_000);
      window.__habibiClipboardImage = value => { clearTimeout(timer); window.__habibiClipboardImage = null; resolve(value || { ok:false }); };
      nativeBridge.postMessage({ type:'clipboardImage' });
    });
    if (payload?.ok && /^data:image\//.test(payload.dataUrl || '')) {
      const response = await fetch(payload.dataUrl);
      const blob = await response.blob();
      return [new File([blob], 'Pasted screenshot.png', { type:blob.type || 'image/png' })];
    }
  } catch (_) { /* An unavailable pasteboard falls through to the clear UI message. */ }
  return [];
}
async function pastedImageFiles(clipboard) {
  const fromItems = [...(clipboard?.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
  const direct = fromItems.length ? fromItems : [...(clipboard?.files || [])];
  if (direct.length) return direct;
  // WKWebView sometimes advertises an image MIME type but omits DataTransfer
  // files. The async Clipboard API recovers macOS screenshots in that case.
  const hasImage = [...(clipboard?.types || [])].some(type => /^image\/|^public\.(png|jpeg|tiff)$/i.test(type));
  if (hasImage && navigator.clipboard?.read) {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(candidate => candidate.startsWith('image/'));
        if (type) return [new File([await item.getType(type)], `Pasted image.${type.split('/')[1] || 'png'}`, { type })];
      }
    } catch (_) { /* Clipboard privacy controls can deny the fallback. */ }
  }
  return [];
}
function requestNativeClipboardImage() {
  const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
  if (!nativeBridge) return false;
  nativeBridge.postMessage({ type:'clipboardImage' });
  return true;
}
async function receiveNativeClipboardImage(payload) {
  if (!payload?.ok || !/^data:image\//.test(payload.dataUrl || '')) return notify('Habibi could not read an image from the clipboard.');
  // Avoid fetch(data:) here. WKWebView can apply an origin policy to a data
  // URL even when native macOS has already supplied valid bytes. Decode the
  // base64 payload directly instead.
  const [header, encoded = ''] = payload.dataUrl.split(',', 2);
  const mime = header.match(/^data:([^;]+);base64$/i)?.[1] || 'image/png';
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const blob = new Blob([bytes], { type:mime });
  const files = [new File([blob], 'Pasted screenshot.png', { type:blob.type || 'image/png' })];
  if (typeof window.__habibiAttachPastedFiles === 'function') return window.__habibiAttachPastedFiles(files);
  showEphemeralHabibiChat('', { files });
}
window.__habibiBeginNativeClipboardImage = () => notify('Adding image…');
window.__habibiReceiveNativeClipboardImage = payload => { receiveNativeClipboardImage(payload).catch(() => notify('Habibi could not read an image from the clipboard.')); };
window.__habibiNativePasteImage = () => {
  if (!requestNativeClipboardImage()) notify('Habibi could not read an image from the clipboard.');
};
function showSettings({ focus } = {}) {
  track('habibi.settings.opened', { surface:'settings', app_type:'native', app_version:'0.1.0' });
  activeShortcutCapture?.();
  launcherMode = 'settings'; defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = 'Settings';
  const native = Boolean(window.webkit?.messageHandlers?.habibiNative);
  const theme = document.body.dataset.theme || 'deep-ocean';
  const colorMode = document.body.dataset.colorMode || 'dark';
  const currentShortcut = document.body.dataset.nativeShortcutLabel || '⌥ Space';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-settings">${icon('arrow-left')} Habibi</button><span class="verified">● local preferences</span></div><section class="provider-setup settings-view"><div class="chat-title"><span class="icon agents">${icon('settings-2')}</span><span><b>Settings</b><small>Everything below stays on this Mac.</small></span></div><div class="settings-section"><div class="appearance-heading"><span class="briefing-heading">APPEARANCE</span><div class="mode-toggle" role="group" aria-label="Color mode"><button class="${colorMode === 'dark' ? 'selected' : ''}" data-color-mode="dark">${icon('moon')} Dark</button><button class="${colorMode === 'light' ? 'selected' : ''}" data-color-mode="light">${icon('sun')} Light</button></div></div><div class="theme-gallery">${themeCatalog.map(item => `<button class="theme-card ${theme === item.id ? 'selected' : ''}" data-theme-choice="${item.id}" aria-label="Use ${item.name}"><span class="theme-thumb theme-${item.id}" style="--theme-ink:${item.swatches[2]};--theme-surface:${item.swatches[1]};--theme-base:${item.swatches[0]}"><i></i><b></b><em></em></span><span><b>${item.name}</b><small>${item.description}</small></span>${theme === item.id ? `<i class="theme-check">${icon('check')}</i>` : ''}</button>`).join('')}</div></div><div class="settings-section"><span class="briefing-heading">LAUNCHER SHORTCUT</span><div class="shortcut-recorder"><span class="shortcut-current">Current: <kbd id="shortcut-current">${escapeHtml(currentShortcut)}</kbd></span><button class="shortcut-listen" id="shortcut-listen"><span>${icon('keyboard')}</span><b>Click, then press a shortcut</b><small id="shortcut-listen-copy">We’ll check whether macOS can use it.</small></button><div class="shortcut-candidate hidden" id="shortcut-candidate"><span><b id="shortcut-candidate-label">—</b><small id="shortcut-candidate-status"></small></span><button class="primary" id="shortcut-save" disabled>Save shortcut</button></div></div>${native ? '' : '<small class="settings-note">Open Habibi.app to check and save a global shortcut.</small>'}</div></section>`);
  const settingsLogo = document.createElement('img'); settingsLogo.className = 'identity-logo'; settingsLogo.src = '/assets/logo.png'; settingsLogo.alt = 'Habibi';
  resultsView.querySelector('.chat-title .icon')?.replaceWith(settingsLogo);
  const layout = homeLayout();
  const layoutSection = document.createElement('section');
  layoutSection.className = 'settings-section home-layout-settings';
  setHtml(layoutSection, `<div class="appearance-heading"><span class="briefing-heading">HOME LAYOUT</span><small>Search always stays visible.</small></div><div class="home-layout-controls">${[
    ['header','Top bar','Brand and privacy status','panel-top'],
    ['briefing','Briefing','Your proactive summary','sparkles'],
    ['calendar','Calendar','Up next and events','calendar-days'],
    ['mail','Recent mail','New mail on Home','mail'],
    ['suggestions','Suggestions','Quick example prompts','lightbulb'],
    ['footer','Keyboard footer','Navigation hints and count','keyboard'],
    ['focusOnly','Minimal when clear','Show Home only when real context arrives','panel-top-close'],
  ].map(([id, title, detail, iconName]) => `<label class="home-layout-control"><span class="home-layout-icon">${icon(iconName)}</span><span><b>${title}</b><small>${detail}</small></span><input type="checkbox" data-home-layout="${id}" ${layout[id] ? 'checked' : ''} aria-label="Show ${title}" /></label>`).join('')}</div>`);
  const settingsSections = [...resultsView.querySelectorAll('.settings-section')];
  settingsSections[1]?.before(layoutSection);
  const analyticsSection = document.createElement('section');
  analyticsSection.className = 'settings-section home-layout-settings';
  setHtml(analyticsSection, `<div class="appearance-heading"><span class="briefing-heading">PRODUCT ANALYTICS</span><small>Anonymous. On by default; turn off anytime.</small></div><label class="home-layout-control"><span class="home-layout-icon">${icon('chart-no-axes-combined')}</span><span><b>Help improve Habibi</b><small>Only product events. Never searches, files, messages, contacts, or paths.</small></span><input type="checkbox" id="analytics-enabled" ${analyticsEnabled() ? 'checked' : ''} aria-label="Enable anonymous product analytics" /></label>`);
  layoutSection.after(analyticsSection);
  analyticsSection.querySelector('#analytics-enabled').addEventListener('change', event => {
    const enabled = event.currentTarget.checked;
    setAnalyticsEnabled(enabled);
    if (enabled) track('habibi.settings.opened', { surface:'analytics-consent', outcome:'enabled', app_type:'native', app_version:'0.1.0' });
  });
  const onboardingSection = document.createElement('section');
  onboardingSection.className = 'settings-section settings-getting-started';
  onboardingSection.innerHTML = `<div class="appearance-heading"><span class="briefing-heading">GETTING STARTED</span><small>Reconnect or revisit setup any time.</small></div><button class="home-layout-control" id="restart-getting-started" type="button"><span class="home-layout-icon">${icon('rocket')}</span><span><b>Open getting started</b><small>Shortcut, Mail, WhatsApp, and model setup</small></span><i>${icon('arrow-up-right')}</i></button>`;
  analyticsSection.after(onboardingSection);
  onboardingSection.querySelector('#restart-getting-started').onclick = reopenGettingStarted;
  layoutSection.querySelectorAll('[data-home-layout]').forEach(toggle => toggle.addEventListener('change', () => saveHomeLayout(toggle.dataset.homeLayout, toggle.checked)));
  document.querySelector('#back-settings').onclick = () => { activeShortcutCapture?.(); showDefault(); };
  resultsView.querySelectorAll('[data-theme-choice]').forEach(button => button.onclick = () => { applyTheme(button.dataset.themeChoice); showSettings(); });
  resultsView.querySelectorAll('[data-color-mode]').forEach(button => button.onclick = () => { applyColorMode(button.dataset.colorMode); showSettings(); });
  const listen = document.querySelector('#shortcut-listen'); const candidate = document.querySelector('#shortcut-candidate'); const candidateLabel = document.querySelector('#shortcut-candidate-label'); const candidateStatus = document.querySelector('#shortcut-candidate-status'); const save = document.querySelector('#shortcut-save'); let pendingShortcut = null; let captureTimeout = null;
  const stopListening = () => { window.removeEventListener('keydown', onShortcutKey, true); clearTimeout(captureTimeout); captureTimeout = null; if (activeShortcutCapture === stopListening) activeShortcutCapture = null; if (!listen?.isConnected) return; listen.classList.remove('listening'); listen.querySelector('b').textContent = 'Click, then press a shortcut'; };
  const onShortcutKey = event => {
    if (!listen.classList.contains('listening')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Escape') { candidate.classList.add('hidden'); stopListening(); return; }
    // Modifier keys are part of a chord, never a completed shortcut. Keep
    // capture mode alive and swallow every event so the launcher cannot react.
    if (['Meta', 'Alt', 'Control', 'Shift'].includes(event.key)) return;
    const value = shortcutPayload(event);
    candidate.classList.remove('hidden'); save.disabled = true;
    if (!value) { candidateLabel.textContent = 'Choose a modified key'; candidateStatus.textContent = 'Use ⌘, ⌥, or ⌃ with a key.'; candidate.scrollIntoView({ block:'nearest', behavior:'smooth' }); stopListening(); return; }
    pendingShortcut = value; candidateLabel.textContent = `Shortcut captured: ${shortcutLabel(value)}`; candidateStatus.textContent = native ? 'Checking availability…' : 'Open Habibi.app to check this shortcut.'; candidate.scrollIntoView({ block:'nearest', behavior:'smooth' }); stopListening();
    if (native) window.webkit.messageHandlers.habibiNative.postMessage({ type:'shortcutCheck', ...value });
  };
  window.__habibiShortcutValidation = result => {
    if (!pendingShortcut || !candidate?.isConnected) return;
    candidateStatus.textContent = result.message || (result.available ? 'Available' : 'Already in use');
    candidate.classList.toggle('available', Boolean(result.available)); save.disabled = !result.available;
    if (result.saved) { localStorage.setItem(onboardingShortcutKey, 'done'); document.body.dataset.nativeShortcutLabel = shortcutLabel(pendingShortcut); document.querySelector('#shortcut-current').textContent = shortcutLabel(pendingShortcut); candidateStatus.textContent = 'Saved — Habibi will use this globally.'; save.disabled = true; }
  };
  listen.onclick = () => { activeShortcutCapture?.(); listen.classList.add('listening'); listen.querySelector('b').textContent = 'Listening… press your shortcut'; candidate.classList.add('hidden'); activeShortcutCapture = stopListening; window.addEventListener('keydown', onShortcutKey, true); captureTimeout = setTimeout(() => { if (listen.classList.contains('listening')) { candidate.classList.remove('hidden'); candidateLabel.textContent = 'Stopped listening'; candidateStatus.textContent = 'Click once more whenever you are ready.'; stopListening(); } }, 12_000); };
  save.onclick = () => { if (pendingShortcut && native) window.webkit.messageHandlers.habibiNative.postMessage({ type:'shortcutSave', label:shortcutLabel(pendingShortcut), ...pendingShortcut }); };
  refreshIcons();
  if (focus === 'shortcut') requestAnimationFrame(() => document.querySelector('#shortcut-listen')?.focus({ preventScroll:true }));
}
function markActivity() { localStorage.setItem('habibi.lastActivity', String(Date.now())); renderQuickSamples(); }
function renderQuickSamples() {
  const samples = document.querySelector('#quick-samples');
  if (!samples) return;
  const lastActivity = Number(localStorage.getItem('habibi.lastActivity') || 0);
  const shouldShow = !lastActivity || Date.now() - lastActivity > 36 * 60 * 60 * 1000;
  samples.classList.toggle('hidden', !shouldShow);
}
function notify(message) { toast.textContent=message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2500); }
// The payload is sent with the request so the service can bind the token to it.
// Whatever is passed here must match what the consuming route later validates.
async function requestApproval(action, payload) {
  const response = await fetch('/api/approvals', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ action, payload }) });
  const result = await response.json();
  if (!result.ok || !result.approval?.token) throw new Error(result.error || 'Could not confirm this action');
  return result.approval.token;
}
async function requestNativeLockScreen() {
  const bridge = window.webkit?.messageHandlers?.habibiNative;
  if (!bridge) throw new Error('Lock Screen requires the native Habibi app.');
  const result = await new Promise(resolve => {
    const timer = setTimeout(() => { window.__habibiNativeLockResult = null; resolve({ ok:false }); }, 5_000);
    window.__habibiNativeLockResult = value => { clearTimeout(timer); window.__habibiNativeLockResult = null; resolve(value || { ok:false }); };
    bridge.postMessage({ type:'lockScreen' });
  });
  if (!result.ok) throw new Error(result.permission ? 'Allow Habibi in Privacy & Security → Accessibility, then try again.' : 'Could not lock this Mac.');
}
const keyboard = createKeyboardController({ input, defaultView, resultsView, getMode:() => launcherMode, notify });
function handleConfirmationKeyboard(event) {
  const confirmation = document.querySelector('.system-action-confirm');
  if (!confirmation || event.metaKey || event.ctrlKey || event.altKey) return false;
  const choices = [...confirmation.querySelectorAll('.confirmation-choice:not([disabled])')];
  if (!choices.length) return false;
  const select = choice => {
    confirmation.dataset.confirmChoice = choice.dataset.choice || 'confirm';
    choices.forEach(button => button.classList.toggle('selected', button === choice));
    choice.focus({ preventScroll:true });
  };
  const consume = () => { event.preventDefault(); event.stopImmediatePropagation(); return true; };
  const selectedIndex = Math.max(0, choices.findIndex(button => button.classList.contains('selected')));
  if (event.key === 'Escape') { (choices.find(button => button.dataset.choice === 'cancel') || confirmation.querySelector('.back-button'))?.click(); return consume(); }
  if (['ArrowLeft', 'ArrowUp'].includes(event.key)) { select(choices[(selectedIndex - 1 + choices.length) % choices.length]); return consume(); }
  if (['ArrowRight', 'ArrowDown'].includes(event.key)) { select(choices[(selectedIndex + 1) % choices.length]); return consume(); }
  if (event.key === 'Enter') { (choices.find(button => button.classList.contains('selected')) || choices[0])?.click(); return consume(); }
  return false;
}
// Capture before individual inputs or the scrolling surface can consume an
// arrow key. Any page using `.system-action-confirm` gets this automatically.
document.addEventListener('keydown', event => { handleConfirmationKeyboard(event); }, true);
// A click on empty launcher space leaves WebKit's scroll view as the responder.
// Capture its arrows before the browser turns them into panel scrolling; real
// form controls retain their native arrow behavior, while the command input
// keeps the existing result-navigation contract below.
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  const target = event.target;
  if (target === input || !(target instanceof HTMLElement)) return;
  if (target.matches('input, textarea, select, [contenteditable="true"], button, a') || target.closest('input, textarea, select, [contenteditable="true"], button, a')) return;
  if (!target.closest('.content, #default-view, #results-view')) return;
  event.preventDefault();
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  if (resultsView.classList.contains('hidden')) keyboard.navigateKeyboard(direction);
  else keyboard.navigateResults(direction, launcherMode !== 'whatsapp');
}, true);
function activateResult(result) {
  if (!result) return;
  track('habibi.result.opened', { result_type:String(result.dataset.type || 'unknown').slice(0, 32), surface:launcherMode || 'search', app_type:'native', app_version:'0.1.0' });
  if (result.dataset.mailThread) return showMailThread(result.dataset.mailThread, result.dataset.mailProvider);
  if (result.dataset.type === 'chat' && result.dataset.chat) {
    const chat = JSON.parse(decodeURIComponent(result.dataset.chat));
    const intent = launcherMode === 'whatsapp' ? chatIntentFromSearch(chat, input.value) : null;
    showWhatsAppChat(chat);
    if (intent?.instruction) draftWhatsAppMessage(chat, intent.instruction, input.value);
    return;
  }
  if (result.dataset.type === 'app' && result.dataset.path) return openAppResult(result);
  if (result.dataset.type === 'kubernetes') return showKubernetes(input.value);
  if (result.dataset.type === 'codex' || result.dataset.type === 'claude') return showAgentSessions(result.dataset.type);
  if (result.dataset.type === 'system') {
    if (result.dataset.systemAction === 'quitApps') return showRunningApplications('quit');
    if (result.dataset.systemAction === 'forceQuitApps') return showRunningApplications('force');
    return showSystemAction(result.dataset.systemAction, result.dataset.title);
  }
  if (result.dataset.type === 'preferences') return showSettings();
  if (result.dataset.type === 'folder') return openKnownFolder(result.dataset.folder);
  showAction(result.dataset.type, result.dataset.title, result.dataset.path && decodeURIComponent(result.dataset.path));
}

function showKubernetes(initialQuery = '') {
  stopKubernetesLogFollow();
  launcherMode = 'kubernetes';
  const query = String(initialQuery || '').trim();
  input.value = query.replace(/^(?:k8s|kubernetes)\s*/i, '');
  input.placeholder = 'Try: get pods -A · logs api-7c9d -n production';
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = 'Kubernetes';
  const resources = [['pods','Pods'],['deployments','Deployments'],['services','Services'],['events','Events'],['statefulsets','StatefulSets'],['daemonsets','DaemonSets'],['replicasets','ReplicaSets'],['jobs','Jobs'],['cronjobs','CronJobs'],['ingresses','Ingresses'],['configmaps','ConfigMaps'],['secrets','Secrets'],['namespaces','Namespaces'],['nodes','Nodes']];
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-kubernetes">${icon('arrow-left')} Habibi</button><span class="verified">● kubectl</span></div><section class="kubernetes-client"><div class="kubernetes-workspace-chrome"><div class="kubernetes-heading"><span class="kubernetes-mark">${icon('ship-wheel')}<span class="kubernetes-habibi-mark"><img src="/assets/logo.png" alt="Habibi" /></span></span><span><b>Kubernetes</b><small>Local cluster explorer · every query is audited on this Mac.</small></span></div><div class="kubernetes-toolbar"><div class="kubernetes-scopes"><div class="kubernetes-context"><span>Context</span><div class="kubernetes-context-picker"><button type="button" class="kubernetes-context-trigger" id="kubernetes-context-trigger" aria-haspopup="listbox" aria-expanded="false" disabled><span>Loading contexts…</span>${icon('chevrons-up-down')}</button><div class="kubernetes-context-menu hidden" id="kubernetes-context-menu" role="listbox" aria-label="Kubernetes context"></div></div></div><div class="kubernetes-context"><span>Namespace</span><div class="kubernetes-context-picker"><button type="button" class="kubernetes-context-trigger" id="kubernetes-namespace-trigger" aria-haspopup="listbox" aria-expanded="false" disabled><span>All namespaces</span>${icon('chevrons-up-down')}</button><div class="kubernetes-context-menu hidden" id="kubernetes-namespace-menu" role="listbox" aria-label="Kubernetes namespace"></div></div></div></div></div><div class="kubernetes-resource-rail" id="kubernetes-samples">${resources.map(([kind, label]) => `<button data-kubernetes-kind="${kind}" title="Browse ${label}">${escapeHtml(label)}</button>`).join('')}</div></div><div class="kubernetes-output" id="kubernetes-output">${kubernetesLoading('Loading cluster overview', 'Reading pods, deployments, and services in parallel.')}</div></section>`);
  document.querySelector('#back-kubernetes').onclick = showDefault;
  resultsView.querySelectorAll('[data-kubernetes-kind]').forEach(button => button.onclick = () => showKubernetesResourceList(button.dataset.kubernetesKind));
  refreshIcons();
  requestAnimationFrame(() => input.focus({ preventScroll:true }));
  loadKubernetesOverview();
  if (input.value.trim()) setTimeout(runKubernetesQuery, 30);
}
function kubernetesLoading(title, detail = '') {
  return `<div class="kubernetes-loading" aria-live="polite"><div class="kubernetes-loading-title"><span class="spinner"></span><span><b>${escapeHtml(title)}</b>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</span></div><div class="kubernetes-loading-skeleton"><i></i><i></i><i></i><i></i><i></i></div></div>`;
}
function renderKubernetesOverview(data) {
  const output = document.querySelector('#kubernetes-output'); const trigger = document.querySelector('#kubernetes-context-trigger');
  if (!output || !trigger) return;
  if (!data.ok) { setHtml(output, `<div class="local-files-empty">${escapeHtml(data.error || 'Could not load your Kubernetes contexts.')}</div>`); trigger.disabled = true; return; }
  kubernetesState = { context:data.context || '', contexts:data.contexts || [], namespace:data.namespace || '', namespaces:data.namespaces || [] };
  renderKubernetesScopePickers();
  const title = { pods:'Pods', deployments:'Deployments', services:'Services' };
  const resourceCard = resource => {
    const items = resource.items || [];
    if (!resource.ok) return `<section class="kubernetes-resource"><header><b>${title[resource.kind] || resource.kind}</b></header><small>${escapeHtml(resource.error || `Could not load ${resource.kind}.`)}</small></section>`;
    return `<section class="kubernetes-resource"><header><span><b>${title[resource.kind] || resource.kind}</b><small>${items.length}${items.length === 80 ? '+' : ''} visible</small></span><button type="button" data-kubernetes-query="get ${resource.kind} -A">View all ${icon('arrow-up-right')}</button></header>${items.length ? `<div class="kubernetes-list">${items.map(item => `<button class="kubernetes-item" data-kubernetes-detail="true" data-kubernetes-kind="${escapeHtml(resource.kind)}" data-kubernetes-name="${escapeHtml(item.name)}" data-kubernetes-namespace="${escapeHtml(item.namespace)}"><span class="kubernetes-resource-name"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.namespace)}</small></span><span class="kubernetes-resource-meta"><em>${escapeHtml(item.primary || '')}</em><small>${escapeHtml(item.secondary || '')}</small></span>${item.badge ? `<i>${escapeHtml(item.badge)}</i>` : ''}</button>`).join('')}</div>` : '<div class="kubernetes-empty">Nothing here in this context.</div>'}</section>`;
  };
  setHtml(output, `<div class="kubernetes-overview-head"><span><b>Cluster overview</b><small>${escapeHtml(data.context || 'No context selected')}</small></span><span>${(data.resources || []).reduce((total, resource) => total + (resource.items?.length || 0), 0)} resources</span></div>${(data.resources || []).map(resourceCard).join('')}`);
  output.querySelectorAll('[data-kubernetes-query]').forEach(button => button.onclick = () => { input.value = button.dataset.kubernetesQuery; runKubernetesQuery(); });
  output.querySelectorAll('[data-kubernetes-detail]').forEach(button => button.onclick = () => showKubernetesDetail(button.dataset.kubernetesKind, button.dataset.kubernetesName, button.dataset.kubernetesNamespace));
  refreshIcons();
}
function renderKubernetesScopePicker({ triggerId, menuId, options, selected, label, dataAttribute, onSelect }) {
  const trigger = document.querySelector(`#${triggerId}`); const menu = document.querySelector(`#${menuId}`);
  if (!trigger || !menu) return;
  setHtml(trigger, `<span>${escapeHtml(selected || (label === 'Namespace' ? 'All namespaces' : 'No context found'))}</span>${icon('chevrons-up-down')}`);
  trigger.disabled = !options.length;
  setHtml(menu, options.map(option => `<button type="button" role="option" aria-selected="${option.value === selected}" class="kubernetes-context-option ${option.value === selected ? 'selected' : ''}" ${dataAttribute}="${escapeHtml(option.value)}"><span>${escapeHtml(option.label)}</span>${option.value === selected ? icon('check') : ''}</button>`).join(''));
  const close = restoreFocus => { menu.classList.add('hidden'); trigger.setAttribute('aria-expanded', 'false'); if (restoreFocus) trigger.focus({ preventScroll:true }); };
  const open = () => { menu.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true'); const selected = menu.querySelector('.selected') || menu.querySelector('button'); selected?.focus({ preventScroll:true }); };
  trigger.onclick = () => menu.classList.contains('hidden') ? open() : close(false);
  trigger.onkeydown = event => { if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); } if (event.key === 'Escape') { event.preventDefault(); close(false); input.focus({ preventScroll:true }); } };
  menu.querySelectorAll(`[${dataAttribute}]`).forEach((button, index, buttons) => {
    button.onclick = () => { close(false); onSelect(button.getAttribute(dataAttribute) || ''); };
    button.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); button.click(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus({ preventScroll:true }); }
    };
  });
  refreshIcons();
}
function renderKubernetesScopePickers() {
  renderKubernetesScopePicker({ triggerId:'kubernetes-context-trigger', menuId:'kubernetes-context-menu', options:(kubernetesState.contexts || []).map(value => ({ value, label:value })), selected:kubernetesState.context, label:'Context', dataAttribute:'data-kubernetes-context', onSelect:context => loadKubernetesOverview(context, '') });
  renderKubernetesScopePicker({ triggerId:'kubernetes-namespace-trigger', menuId:'kubernetes-namespace-menu', options:[{ value:'', label:'All namespaces' }, ...(kubernetesState.namespaces || []).map(value => ({ value, label:value }))], selected:kubernetesState.namespace, label:'Namespace', dataAttribute:'data-kubernetes-namespace', onSelect:namespace => loadKubernetesOverview(kubernetesState.context, namespace) });
}
async function loadKubernetesOverview(context = kubernetesState.context || '', namespace = kubernetesState.namespace || '') {
  const output = document.querySelector('#kubernetes-output'); if (!output) return;
  setHtml(output, kubernetesLoading('Loading cluster overview', 'Reading pods, deployments, and services in parallel.'));
  try { renderKubernetesOverview(await fetch(`/api/kubernetes/overview?context=${encodeURIComponent(context)}&namespace=${encodeURIComponent(namespace)}`).then(response => response.json())); }
  catch (_) { renderKubernetesOverview({ ok:false, error:'Could not load your Kubernetes overview.' }); }
}
async function runKubernetesQuery() {
  const query = input.value.trim();
  const output = document.querySelector('#kubernetes-output');
  if (!output) return;
  if (!query) { setHtml(output, '<div class="local-files-empty">Try: get pods -A, describe deployment api -n production, logs api-7c9d -n production, or events -A.</div>'); return; }
  const direct = /^(?:kubectl\s+)?(?:get|describe|logs|events)\b/i.test(query);
  setHtml(output, kubernetesLoading(direct ? 'Planning a Kubernetes query' : 'Investigating Kubernetes', direct ? 'Habibi will only run safe kubectl reads.' : 'Inspecting relevant resources and bounded logs locally.'));
  try {
    const response = await fetch(direct ? '/api/kubernetes/query' : '/api/kubernetes/diagnose', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ query, context:kubernetesState.context, namespace:kubernetesState.namespace }) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'kubectl could not complete that query.');
    if (!direct) {
      setHtml(output, `<div class="kubernetes-diagnosis"><header><span>${icon('sparkles')} Diagnosis</span><small>${escapeHtml(result.target ? `${result.target.kind}/${result.target.name}${result.target.namespace ? ` · ${result.target.namespace}` : ''}` : 'No target')}</small></header><article>${renderAssistantMarkdown(result.summary || 'No diagnosis was produced.')}</article><section class="kubernetes-tool-trace">${(result.trace || []).map(step => `<div><b>${escapeHtml(step.tool)}</b><small>${escapeHtml(step.detail)}</small></div>`).join('')}</section>${result.logs ? `<details><summary>Latest log tail</summary><pre>${escapeHtml(result.logs)}</pre></details>` : ''}</div>`);
      count.textContent = 'Kubernetes · diagnosis';
    } else { setHtml(output, `<div class="kubernetes-query-result"><pre>${escapeHtml(result.output || 'No resources found.')}</pre></div>`); count.textContent = `Kubernetes · ${result.action}`; }
  } catch (error) { setHtml(output, `<div class="local-files-empty">${escapeHtml(error.message || 'Could not run kubectl.')}</div>`); }
}
async function showKubernetesDetail(kind, name, namespace) {
  stopKubernetesLogFollow();
  const output = document.querySelector('#kubernetes-output');
  if (!output) return;
  setHtml(output, kubernetesLoading('Reading resource details', 'Fetching the selected resource and its safe metadata.'));
  try {
    const response = await fetch('/api/kubernetes/detail', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ kind, name, namespace, context:kubernetesState.context }) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Could not inspect this resource.');
    const detail = result.detail;
    const logsAction = detail.kind === 'pods' ? `<button type="button" class="kubernetes-log-button" id="kubernetes-open-logs">${icon('scroll-text')} Logs</button>` : '';
    const relatedPods = detail.relatedPods?.length ? `<section class="kubernetes-detail-section"><h3>Related pods</h3><div class="kubernetes-list">${detail.relatedPods.map(pod => `<button class="kubernetes-item" data-related-pod="true" data-kubernetes-name="${escapeHtml(pod.name)}" data-kubernetes-namespace="${escapeHtml(pod.namespace)}"><span class="kubernetes-resource-name"><b>${escapeHtml(pod.name)}</b><small>${escapeHtml(pod.namespace)}</small></span><span class="kubernetes-resource-meta"><em>${escapeHtml(pod.primary)}</em><small>${escapeHtml(pod.secondary)}</small></span><i>Logs</i></button>`).join('')}</div></section>` : '';
    setHtml(output, `<div class="kubernetes-detail"><button type="button" class="kubernetes-detail-back" id="kubernetes-detail-back">${icon('arrow-left')} Cluster overview</button><header><span><small>${escapeHtml(detail.kind)}</small><b>${escapeHtml(detail.name)}</b><em>${escapeHtml(detail.namespace || 'cluster scoped')}</em></span><span class="kubernetes-detail-actions">${logsAction}<i>${icon('boxes')}</i></span></header><section class="kubernetes-facts">${detail.facts.map(([label, value]) => `<div><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></div>`).join('')}</section>${detail.containers?.length ? `<section class="kubernetes-detail-section"><h3>Containers</h3>${detail.containers.map(container => `<div class="kubernetes-container"><span><b>${escapeHtml(container.name)}</b><small>${escapeHtml(container.image)}</small></span><span><em class="${container.ready ? 'ready' : ''}">${escapeHtml(container.state)}</em><small>${container.restarts} restart${container.restarts === 1 ? '' : 's'}</small></span></div>`).join('')}</section>` : ''}${relatedPods}${detail.conditions?.length ? `<section class="kubernetes-detail-section"><h3>Conditions</h3>${detail.conditions.map(condition => `<div class="kubernetes-condition"><span><b>${escapeHtml(condition.type)}</b><small>${escapeHtml(condition.reason || condition.message || 'No additional detail')}</small></span><em class="${condition.status === 'True' ? 'ready' : ''}">${escapeHtml(condition.status)}</em></div>`).join('')}</section>` : ''}${detail.labels?.length ? `<section class="kubernetes-detail-section"><h3>Labels</h3><div class="kubernetes-labels">${detail.labels.map(label => `<span><b>${escapeHtml(label.key)}</b>${escapeHtml(label.value)}</span>`).join('')}</div></section>` : ''}</div>`);
    document.querySelector('#kubernetes-detail-back').onclick = () => loadKubernetesOverview();
    document.querySelector('#kubernetes-open-logs')?.addEventListener('click', () => showKubernetesLogs(detail.name, detail.namespace));
    output.querySelectorAll('[data-related-pod]').forEach(button => button.onclick = () => showKubernetesLogs(button.dataset.kubernetesName, button.dataset.kubernetesNamespace));
    refreshIcons();
  } catch (error) { setHtml(output, `<div class="local-files-empty">${escapeHtml(error.message || 'Could not inspect this resource.')}</div>`); }
}
async function showKubernetesResourceList(kind) {
  stopKubernetesLogFollow();
  const output = document.querySelector('#kubernetes-output');
  if (!output) return;
  setHtml(output, kubernetesLoading('Loading resources', 'Fetching a compact, readable list.'));
  try {
    const response = await fetch('/api/kubernetes/resources', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ kind, context:kubernetesState.context, namespace:kubernetesState.namespace }) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Could not load these resources.');
    const label = String(result.kind || kind).replace(/\b\w/g, letter => letter.toUpperCase());
    setHtml(output, `<div class="kubernetes-subpage"><header><button type="button" class="kubernetes-detail-back" id="kubernetes-list-back">${icon('arrow-left')} Cluster overview</button><span><b>${escapeHtml(label)}</b><small>${result.items.length} visible in this context</small></span></header><div class="kubernetes-list">${result.items.map(item => `<button class="kubernetes-item" data-kubernetes-detail="true" data-kubernetes-kind="${escapeHtml(result.kind)}" data-kubernetes-name="${escapeHtml(item.name)}" data-kubernetes-namespace="${escapeHtml(item.namespace)}"><span class="kubernetes-resource-name"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.namespace)}</small></span><span class="kubernetes-resource-meta"><em>${escapeHtml(item.primary || '')}</em><small>${escapeHtml(item.secondary || '')}</small></span>${item.badge ? `<i>${escapeHtml(item.badge)}</i>` : ''}</button>`).join('') || '<div class="kubernetes-empty">Nothing here in this context.</div>'}</div></div>`);
    document.querySelector('#kubernetes-list-back').onclick = () => loadKubernetesOverview();
    output.querySelectorAll('[data-kubernetes-detail]').forEach(button => button.onclick = () => showKubernetesDetail(button.dataset.kubernetesKind, button.dataset.kubernetesName, button.dataset.kubernetesNamespace));
    refreshIcons();
  } catch (error) { setHtml(output, `<div class="local-files-empty">${escapeHtml(error.message || 'Could not load these resources.')}</div>`); }
}
function stopKubernetesLogFollow() { if (kubernetesLogFollowTimer) { clearInterval(kubernetesLogFollowTimer); kubernetesLogFollowTimer = null; } }
function renderKubernetesLogOutput({ stickToBottom = false } = {}) {
  const output = document.querySelector('#kubernetes-log-output');
  const filter = document.querySelector('#kubernetes-log-filter');
  const count = document.querySelector('#kubernetes-log-count');
  if (!output) return;
  const query = String(filter?.value || '').trim().toLowerCase();
  const lines = query ? kubernetesLogLines.filter(line => line.toLowerCase().includes(query)) : kubernetesLogLines;
  setHtml(output, escapeHtml(lines.join('\n') || (query ? 'No matching log lines.' : 'No log lines returned.')));
  if (count) count.textContent = query ? `${lines.length}/${kubernetesLogLines.length} lines` : `${kubernetesLogLines.length} lines`;
  if (stickToBottom && !query) output.scrollTop = output.scrollHeight;
}
async function showKubernetesLogs(pod, namespace) {
  stopKubernetesLogFollow();
  kubernetesLogLines = [];
  const output = document.querySelector('#kubernetes-output');
  if (!output) return;
  const read = async () => {
    const response = await fetch('/api/kubernetes/logs', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ pod, namespace, context:kubernetesState.context }) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Could not read pod logs.');
    kubernetesLogLines = String(result.output || '').split('\n').filter((line, index, lines) => line || index < lines.length - 1);
    renderKubernetesLogOutput({ stickToBottom:true });
    return result;
  };
  setHtml(output, `<div class="kubernetes-log-page"><header><button type="button" class="kubernetes-detail-back" id="kubernetes-logs-back">${icon('arrow-left')} Resource details</button><span><small>Pod logs</small><b>${escapeHtml(pod)}</b><em>${escapeHtml(namespace)}</em></span><button type="button" class="kubernetes-log-button" id="kubernetes-follow-logs">${icon('radio')} Follow</button></header><div class="kubernetes-log-filter-row"><span>${icon('search')}</span><input id="kubernetes-log-filter" type="search" autocomplete="off" placeholder="Filter these log lines…" aria-label="Filter pod logs" /><small id="kubernetes-log-count">Loading…</small></div><pre id="kubernetes-log-output" class="kubernetes-log-output"><span class="spinner"></span> Reading logs…</pre></div>`);
  document.querySelector('#kubernetes-logs-back').onclick = () => showKubernetesDetail('pods', pod, namespace);
  document.querySelector('#kubernetes-log-filter').oninput = () => renderKubernetesLogOutput();
  const follow = document.querySelector('#kubernetes-follow-logs');
  follow.onclick = () => {
    if (kubernetesLogFollowTimer) { stopKubernetesLogFollow(); follow.innerHTML = `${icon('radio')} Follow`; refreshIcons(); return; }
    follow.innerHTML = `${icon('pause')} Pause`; kubernetesLogFollowTimer = setInterval(() => read().catch(() => stopKubernetesLogFollow()), 3000); refreshIcons();
  };
  try { await read(); } catch (error) { setHtml(document.querySelector('#kubernetes-log-output'), escapeHtml(error.message || 'Could not read pod logs.')); }
  refreshIcons();
}

async function openAppResult(result) {
  if (result.dataset.launching === 'true') return;
  const title = result.dataset.title || 'app';
  result.dataset.launching = 'true';
  result.disabled = true;
  result.classList.add('launching');
  const tag = result.querySelector('.result-tag');
  const originalTag = tag?.innerHTML;
  if (tag) {
    tag.classList.add('launching-tag');
    setHtml(tag, '<span class="mini-spinner" aria-hidden="true"></span><span>Opening</span>');
  }
  notify(`Opening ${title}…`);
  try {
    const response = await fetch('/api/open-app', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ path:decodeURIComponent(result.dataset.path) }) });
    const data = await response.json();
    if (!data.ok) throw new Error();
    // `open` has handed the app to Launch Services. The macOS process may
    // still be animating into view, so never claim it is already open.
    notify(`${title} is opening…`);
  } catch (_) {
    notify(`Could not open ${title}`);
  } finally {
    result.dataset.launching = 'false';
    result.disabled = false;
    result.classList.remove('launching');
    if (tag) { tag.classList.remove('launching-tag'); setHtml(tag, originalTag || 'APP'); }
  }
}
async function openKnownFolder(folder) {
  const result = await fetch('/api/open-folder', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ folder }) }).then(response => response.json()).catch(() => ({ ok:false }));
  notify(result.ok ? `Opened ${folder}` : `Could not open ${folder}`);
}

function runningAppIcon(app) {
  return app.path ? `<img src="${safeImageSrc(`/api/app-icon?path=${encodeURIComponent(app.path)}`)}" alt="" onerror="this.remove()" />` : icon('monitor');
}
function runningAppUsage(app) {
  return `${app.cpu.toFixed(1)}% CPU · ${app.memoryMb >= 1024 ? `${(app.memoryMb / 1024).toFixed(1)} GB` : `${app.memoryMb} MB`} RAM`;
}
function showRunningApplications(mode) {
  launcherMode = 'running-apps';
  input.value = '';
  input.placeholder = 'Filter open applications…';
  const force = mode === 'force';
  count.textContent = force ? 'Force Quit · open apps' : 'Quit · open apps';
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden');
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-running-apps">${icon('arrow-left')} Habibi</button><span class="verified">● local process usage</span></div><section class="running-apps"><div class="running-apps-title"><span class="icon agents">${icon(force ? 'octagon-x' : 'circle-stop')}</span><span><b>${force ? 'Force Quit applications' : 'Quit applications'}</b><small>${force ? 'Use only when an app is unresponsive. It may lose unsaved work.' : 'Choose an open app to quit normally.'}</small></span><button type="button" class="history-button" id="refresh-running-apps">${icon('refresh-cw')} Refresh</button></div><div id="running-app-list" class="running-app-list"><div class="loading-state"><span class="spinner"></span> Reading open applications…</div></div></section>`);
  document.querySelector('#back-running-apps').onclick = showDefault;
  runningAppsState = { mode, apps:[] };
  const load = () => fetch('/api/running-apps').then(response => response.json()).then(data => {
    if (launcherMode !== 'running-apps' || runningAppsState?.mode !== mode) return;
    runningAppsState.apps = data.apps || [];
    filterRunningApplications(input.value);
  }).catch(() => { const list = document.querySelector('#running-app-list'); if (list) setHtml(list, '<div class="local-files-empty">Could not read open applications.</div>'); });
  document.querySelector('#refresh-running-apps').onclick = load;
  load();
  requestAnimationFrame(() => input.focus({ preventScroll:true }));
}
function filterRunningApplications(query = '') {
  if (!runningAppsState || launcherMode !== 'running-apps') return;
  const list = document.querySelector('#running-app-list'); if (!list) return;
  const force = runningAppsState.mode === 'force';
  const needle = query.trim().toLowerCase();
  const apps = runningAppsState.apps.filter(app => !needle || `${app.name} ${app.path}`.toLowerCase().includes(needle));
  count.textContent = `${apps.length} open app${apps.length === 1 ? '' : 's'}`;
  setHtml(list, apps.length ? apps.map((app, index) => `<button type="button" class="result running-app ${index === 0 ? 'selected' : ''}" data-running-app="${encodeURIComponent(JSON.stringify(app))}"><span class="icon app-icon">${runningAppIcon(app)}</span><span><b>${escapeHtml(app.name)}</b><small>${escapeHtml(runningAppUsage(app))} · ${app.pids.length} process${app.pids.length === 1 ? '' : 'es'}</small></span><em>${force ? 'FORCE QUIT' : 'QUIT'}</em><i>${icon('chevron-right')}</i></button>`).join('') : `<div class="local-files-empty">No open application matches “${escapeHtml(query)}”.</div>`);
  list.querySelectorAll('[data-running-app]').forEach(button => button.onclick = () => confirmRunningApp(JSON.parse(decodeURIComponent(button.dataset.runningApp)), runningAppsState.mode));
  refreshIcons();
}
function confirmRunningApp(app, mode) {
  const force = mode === 'force';
  const actionLabel = force ? 'Force Quit' : 'Quit';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-running-apps">${icon('arrow-left')} ${force ? 'Force Quit applications' : 'Quit applications'}</button><span class="verified">● review before action</span></div><section class="system-action-confirm ${force ? 'is-dangerous' : ''}" data-confirm-choice="confirm"><div class="system-action-hero"><span class="system-action-icon">${icon(force ? 'octagon-x' : 'circle-stop')}</span><span><span class="compose-label">OPEN APPLICATION</span><h2>${escapeHtml(actionLabel)} ${escapeHtml(app.name)}?</h2><p>${force ? 'This immediately stops the app and may lose unsaved work.' : 'Habibi will ask this app to terminate normally.'}</p></span></div><div class="system-action-note">${icon('activity')}<span>${escapeHtml(runningAppUsage(app))} across ${app.pids.length} process${app.pids.length === 1 ? '' : 'es'}.</span></div><div class="confirmation-options"><button type="button" class="confirmation-choice confirm-option selected" id="confirm-running-app" data-choice="confirm"><span><b>${escapeHtml(actionLabel)} ${escapeHtml(app.name)}</b><small>Requires your confirmation</small></span><kbd>↵</kbd></button><button type="button" class="confirmation-choice confirm-option" id="cancel-running-app" data-choice="cancel"><span><b>Cancel</b><small>Keep ${escapeHtml(app.name)} running</small></span><kbd>esc</kbd></button></div><small class="confirmation-hint"><kbd>↑ ↓</kbd> choose &nbsp; <kbd>↵</kbd> continue &nbsp; <kbd>esc</kbd> go back</small></section>`);
  const back = () => showRunningApplications(mode);
  document.querySelector('#back-running-apps').onclick = back;
  document.querySelector('#cancel-running-app').onclick = back;
  document.querySelector('#confirm-running-app').onclick = async () => {
    const button = document.querySelector('#confirm-running-app'); button.disabled = true; setHtml(button, `<span><span class="mini-spinner"></span> ${escapeHtml(actionLabel)}ing…</span>`);
    try {
      const payload = { app:app.name, mode, pids:app.pids };
      const approvalToken = await requestApproval(`running-app.${mode}`, payload);
      const result = await fetch('/api/running-apps/action', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ ...payload, approvalToken }) }).then(response => response.json());
      if (!result.ok) throw new Error(result.error);
      notify(`${app.name} is ${force ? 'being force quit' : 'quitting'}…`);
      showRunningApplications(mode);
    } catch (error) { notify(error.message || `Could not ${actionLabel.toLowerCase()} ${app.name}`); button.disabled = false; setHtml(button, `<span><b>${escapeHtml(actionLabel)} ${escapeHtml(app.name)}</b><small>Requires your confirmation</small></span><kbd>↵</kbd>`); }
  };
  requestAnimationFrame(() => document.querySelector('#confirm-running-app')?.focus({ preventScroll:true }));
  refreshIcons();
}
async function showAction(type, title, filePath) {
  if (type === 'message' || type === 'whatsapp') return showChatClient();
  if (type === 'assistant') return showAgenticMessage(input.value);
  if (type === 'email') return showMailClient();
  if (type === 'event') return showEventDraft();
  if (type === 'agenda') return showUpcomingEvents();
  if (type === 'agent') return showAgentDock();
  if (type === 'preferences') return showSettings();
  if (type === 'file' && !filePath) { input.focus(); return notify('Type a filename to search your local Spotlight index'); }
  // Opening a local file is a reversible, direct navigation action. Keep this
  // as immediate as Finder/Spotlight rather than inserting an unnecessary
  // approval screen between selection and the file the user chose.
  if (type === 'file' && filePath) {
    try {
      const response = await fetch('/api/open-file', {
        method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ path:filePath })
      });
      const result = await response.json();
      notify(result.ok ? `Opened ${title}` : 'Could not open that file');
    } catch (_) {
      notify('Could not open that file');
    }
    return;
  }
  const actions = {
  };
  const action = actions[type];
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-action">${icon('arrow-left')} Habibi</button><span>External actions need approval</span></div><div class="compose"><span class="compose-label">${escapeHtml(action.label)}</span><h2>${escapeHtml(action.title)}</h2><p>${escapeHtml(action.text)}</p><div class="compose-actions"><button class="primary" id="approve">${action.button} <span>↵</span></button><button class="secondary" id="cancel">Cancel</button></div></div>`);
  document.querySelector('#back-action').onclick = showDefault;
  document.querySelector('#approve').onclick = async () => {
    if (type === 'file' && filePath) {
      const response = await fetch('/api/open-file', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ path:filePath }) });
      const result = await response.json();
      notify(result.ok ? `Opened ${title}` : 'Could not open that file');
    } else notify('This action is not available yet');
    showDefault();
  };
  document.querySelector('#cancel').onclick = showDefault;
  refreshIcons();
}
function showSystemAction(action, title) {
  const copy = { sleep:'Put this Mac to sleep.', restart:'Restart this Mac and close open apps.', shutdown:'Shut down this Mac and close open apps.', lock:'Lock this Mac immediately.', darkMode:'Change the macOS appearance.', emptyTrash:'Permanently remove all Trash items.' }[action];
  if (!copy) return fetch('/api/system/action', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ action }) }).then(response => response.json()).then(result => notify(result.ok ? `Opened ${title}` : result.error || `Could not open ${title}`));
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent='System action';
  const meta = {
    sleep:{ icon:'moon', verb:'Sleep now', detail:'Your Mac can be woken with the keyboard, trackpad, or power button.' },
    restart:{ icon:'rotate-cw', verb:'Restart now', detail:'Any unsaved work in other apps may be lost.' },
    shutdown:{ icon:'power', verb:'Shut down now', detail:'Any unsaved work in other apps may be lost.' },
    lock:{ icon:'lock-keyhole', verb:'Lock screen', detail:'You’ll need your normal macOS sign-in to return.' },
    darkMode:{ icon:'sun-moon', verb:'Change appearance', detail:'This changes macOS appearance, not just Habibi.' },
    emptyTrash:{ icon:'trash-2', verb:'Empty Trash', detail:'Files in Trash cannot be restored after this action.' },
  }[action];
  const isDangerous = ['restart', 'shutdown', 'emptyTrash'].includes(action);
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-system-action">${icon('arrow-left')} Habibi</button><span class="verified">● review before action</span></div><section class="system-action-confirm ${isDangerous ? 'is-dangerous' : ''}" data-confirm-choice="confirm"><div class="system-action-hero"><span class="system-action-icon">${icon(meta.icon)}</span><span><span class="compose-label">SYSTEM ACTION</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p></span></div><div class="system-action-note">${icon('shield-check')}<span>${escapeHtml(meta.detail)}</span></div><div class="confirmation-options" role="group" aria-label="Confirm ${escapeHtml(title)}"><button type="button" class="confirmation-choice confirm-option selected" id="confirm-system-action" data-choice="confirm"><span><b>${escapeHtml(meta.verb)}</b><small>Requires your confirmation</small></span><kbd>↵</kbd></button><button type="button" class="confirmation-choice confirm-option" id="cancel-system-action" data-choice="cancel"><span><b>Keep things as they are</b><small>Return to Habibi</small></span><kbd>esc</kbd></button></div><small class="confirmation-hint"><kbd>← →</kbd> choose &nbsp; <kbd>↵</kbd> continue &nbsp; <kbd>esc</kbd> go back</small></section>`);
  const back = () => showDefault(); document.querySelector('#back-system-action').onclick = back; document.querySelector('#cancel-system-action').onclick = back;
  resultsView.querySelectorAll('.confirmation-choice').forEach(button => button.onclick = () => { document.querySelector('.system-action-confirm').dataset.confirmChoice = button.dataset.choice; resultsView.querySelectorAll('.confirmation-choice').forEach(choice => choice.classList.toggle('selected', choice === button)); if (button.dataset.choice === 'cancel') back(); });
  document.querySelector('#confirm-system-action').onclick = async () => { try { if (action === 'lock') { await requestNativeLockScreen(); return; } const approvalToken = await requestApproval(`system.${action}`, { action }); const result = await fetch('/api/system/action', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ action, approvalToken }) }).then(response => response.json()); if (!result.ok) throw new Error(result.error); notify(`${title} confirmed`); if (!['restart','shutdown'].includes(action)) showDefault(); } catch (error) { notify(error.message || 'Could not confirm this action'); } };
  refreshIcons();
}
function saveEphemeralTurn(sessionId, role, text) {
  try {
    const history = JSON.parse(localStorage.getItem(ephemeralHistoryKey) || '[]');
    history.push({ sessionId, role, text, createdAt:Date.now() });
    localStorage.setItem(ephemeralHistoryKey, JSON.stringify(history.slice(-200)));
  } catch (_) { /* Conversation history is best-effort local state. */ }
}

function showLlmSetup({ afterConfigured } = {}) {
  launcherMode = 'llm-setup';
  defaultView.classList.add('hidden');
  resultsView.classList.remove('hidden');
  count.textContent = 'Set up Habibi';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-setup">${icon('arrow-left')} Habibi</button><span class="verified">● private by design</span></div><section class="provider-setup"><div class="chat-title"><span class="icon agents">${icon('sparkles')}</span><span><b>Connect a model</b><small>Pick a provider first—then we’ll only ask for what it needs.</small></span></div><div class="provider-options" role="radiogroup">${Object.entries(llmProviders).map(([id, provider]) => `<button class="provider-option" data-provider="${id}" role="radio" aria-checked="false"><span><b>${provider.label}</b><small>${provider.description}</small></span><em>${provider.kind === 'local' ? 'LOCAL' : 'YOUR KEY'}</em><i>${icon('chevron-right')}</i></button>`).join('')}</div><div id="provider-detail" aria-live="polite"></div></section>`);
  let selected = 'ollama';
  let activeConfiguration = null;
  let availableModels = [];
  const details = document.querySelector('#provider-detail');
  const select = providerId => {
    selected = providerId;
    const provider = llmProviders[selected];
    document.querySelectorAll('.provider-option').forEach(option => {
      const active = option.dataset.provider === selected;
      option.classList.toggle('selected', active);
      option.setAttribute('aria-checked', String(active));
    });
    const selectedOption = document.querySelector(`.provider-option[data-provider="${selected}"]`);
    selectedOption.after(details);
    const activeModel = activeConfiguration?.provider === selected ? activeConfiguration.model : '';
    const safeActiveModel = escapeHtml(activeModel);
    setHtml(details, `<div class="provider-detail ${activeModel ? 'has-active-model' : ''}"><div class="provider-detail-title"><b>${provider.label}</b><span>${activeModel ? 'Currently active' : provider.kind === 'local' ? 'Runs locally on this Mac' : 'Uses your own API key'}</span></div><div class="provider-fields"><label>Model ${activeModel ? '<em class="active-model-label">Active model</em>' : ''}<span class="model-combobox"><input id="llm-model" class="${activeModel ? 'active-model-input' : ''}" role="combobox" aria-expanded="false" aria-controls="llm-model-menu" value="${safeActiveModel || provider.model}" autocomplete="off" placeholder="Choose or type a model" /><button id="llm-model-trigger" aria-label="Show available models">${icon('chevron-down')}</button><span id="llm-model-menu" class="model-menu hidden" role="listbox"></span></span></label>${provider.kind === 'local' ? `<label>Server address <input id="llm-endpoint" value="${provider.endpoint}" autocomplete="off" /></label>` : `<label>API key <input id="llm-api-key" type="password" autocomplete="off" placeholder="Leave blank to keep the current key" /></label>`}</div><div class="provider-actions"><span id="llm-setup-message">${activeModel ? `Currently using ${safeActiveModel}. Change it below to switch models.` : provider.kind === 'local' ? 'Looking for models on your local server…' : 'Your key is stored in macOS Keychain, never in Habibi.'}</span><button class="primary" id="save-llm">Continue <kbd>↵</kbd></button></div></div>`);
    const modelInput = document.querySelector('#llm-model');
    const modelMenu = document.querySelector('#llm-model-menu');
    const renderModels = (filter = '') => {
      const models = [...new Set([activeModel, ...availableModels].filter(Boolean))];
      const matching = models.filter(model => model.toLowerCase().includes(filter.toLowerCase()));
      setHtml(modelMenu, matching.length ? matching.map((model, index) => `<button class="${model === activeModel ? 'active-model-option' : ''}" role="option" data-model="${escapeHtml(model)}" aria-selected="${model === activeModel || index === 0}"><span>${escapeHtml(model)}</span>${model === activeModel ? '<em>Active</em>' : ''}</button>`).join('') : '<span class="model-empty">Type any installed model name</span>');
      modelMenu.querySelectorAll('[data-model]').forEach(button => button.onclick = () => { modelInput.value = button.dataset.model; closeModelMenu(); modelInput.focus(); });
    };
    const openModelMenu = () => { renderModels(modelInput.value); modelMenu.classList.remove('hidden'); modelInput.setAttribute('aria-expanded', 'true'); };
    const closeModelMenu = () => { modelMenu.classList.add('hidden'); modelInput.setAttribute('aria-expanded', 'false'); };
    document.querySelector('#llm-model-trigger').onclick = () => modelMenu.classList.contains('hidden') ? openModelMenu() : closeModelMenu();
    modelInput.addEventListener('input', () => openModelMenu());
    modelInput.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); document.querySelector('#llm-endpoint, #llm-api-key, #save-llm')?.focus(); }
      if (event.key === 'Escape') { event.preventDefault(); closeModelMenu(); }
      if (event.key === 'Enter' && !modelMenu.classList.contains('hidden')) { event.preventDefault(); closeModelMenu(); document.querySelector('#llm-endpoint, #llm-api-key, #save-llm')?.focus(); }
    });
    document.querySelector('#llm-model-trigger').addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); document.querySelector('#llm-endpoint, #llm-api-key, #save-llm')?.focus(); }
      if (event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); modelInput.focus(); }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); document.querySelector('#llm-model-trigger').click(); }
    });
    const endpoint = document.querySelector('#llm-endpoint')?.value || provider.endpoint;
    fetch(`/api/llm/models?provider=${encodeURIComponent(selected)}&endpoint=${encodeURIComponent(endpoint)}`).then(response => response.json()).then(data => {
      const datalist = document.querySelector('#llm-models');
      if (data.models?.length) {
        availableModels = data.models;
        if (provider.kind === 'local' && modelInput.value === provider.model) modelInput.value = data.models[0];
        renderModels();
        document.querySelector('#llm-setup-message').textContent = `${data.models.length} local model${data.models.length === 1 ? '' : 's'} found — start typing to filter.`;
      } else if (provider.kind === 'local') document.querySelector('#llm-setup-message').textContent = 'No models found yet. Start the local server, or type a model name.';
    }).catch(() => {});
    document.querySelector('#save-llm').onclick = save;
  };
  document.querySelectorAll('.provider-option').forEach(option => option.onclick = () => select(option.dataset.provider));
  document.querySelector('#back-setup').onclick = showDefault;
  document.querySelector('.provider-setup').addEventListener('keydown', event => {
    const providerButtons = [...document.querySelectorAll('.provider-option')];
    const providerIndex = providerButtons.indexOf(document.activeElement);
    if (providerIndex >= 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault(); event.stopPropagation();
      providerButtons[(providerIndex + (event.key === 'ArrowDown' ? 1 : -1) + providerButtons.length) % providerButtons.length].focus();
      return;
    }
    if (providerIndex >= 0 && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); event.stopPropagation(); select(document.activeElement.dataset.provider); document.querySelector('#llm-model')?.focus();
      return;
    }
    const modelButton = document.activeElement.closest?.('#llm-model-menu button');
    if (modelButton && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault(); event.stopPropagation();
      const buttons = [...document.querySelectorAll('#llm-model-menu button')]; const index = buttons.indexOf(modelButton);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
      return;
    }
    if (modelButton && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); modelButton.click(); }
    if (modelButton && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); document.querySelector('#llm-model-trigger')?.click(); document.querySelector('#llm-model')?.focus(); }
  });
  const save = async () => {
    const button = document.querySelector('#save-llm');
    const message = document.querySelector('#llm-setup-message');
    button.disabled = true; setHtml(button, '<span class="mini-spinner"></span> Connecting…');
    const response = await fetch('/api/llm/configure', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ provider:selected, model:document.querySelector('#llm-model').value, endpoint:document.querySelector('#llm-endpoint')?.value || llmProviders[selected].endpoint, apiKey:document.querySelector('#llm-api-key')?.value }) });
    const data = await response.json();
    if (!data.ok || !data.configured) { button.disabled = false; setHtml(button, 'Continue <kbd>↵</kbd>'); message.textContent = data.error || 'Could not connect to that provider.'; return; }
    if (afterConfigured) afterConfigured(); else showEphemeralHabibiChat();
  };
  select(selected);
  fetch('/api/llm/status').then(response => response.json()).then(state => {
    if (!state.configured || !llmProviders[state.provider]) return;
    activeConfiguration = { provider:state.provider, model:state.model || llmProviders[state.provider].model };
    const activeOption = document.querySelector(`.provider-option[data-provider="${state.provider}"]`);
    activeOption?.parentElement?.prepend(activeOption);
    activeOption?.querySelector('em')?.replaceChildren(document.createTextNode('ACTIVE'));
    select(state.provider);
  }).catch(() => {});
  requestAnimationFrame(() => document.querySelector('.provider-option')?.focus());
  refreshIcons();
}

function showEphemeralHabibiChat(initialPrompt = '', initialAttachments = {}) {
  track('habibi.chat.opened', { surface:'assistant', app_type:'native', app_version:'0.1.0' });
  launcherMode = 'habibi-chat';
  const sessionId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  defaultView.classList.add('hidden');
  resultsView.classList.remove('hidden');
  count.textContent = 'Habibi · ephemeral chat';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-habibi">${icon('arrow-left')} Habibi</button><span class="verified" id="habibi-provider">● checking model</span></div><section class="chat-client habibi-chat" id="habibi-ephemeral-chat"><div class="chat-title"><span class="habibi-chat-mark chat-title-mark"><img src="/assets/logo.png" alt="Habibi" /><i>${icon('sparkles')}</i></span><span><b>Habibi</b><small>New private conversation · history saved locally</small></span><button class="history-button" id="configure-model">Model settings</button></div><div class="messages" id="habibi-messages"></div><div class="chat-composer"><div id="habibi-attachments" class="chat-attachments"></div><textarea id="habibi-draft" rows="2" placeholder="Ask anything…" disabled></textarea><input id="habibi-file-input" type="file" multiple hidden /><div><span id="habibi-composer-note">Checking your model…</span><span class="composer-actions"><button type="button" class="composer-icon" id="attach-habibi" title="Attach files" aria-label="Attach files" disabled>${icon('paperclip')}</button><button type="button" class="primary" id="send-habibi" disabled>Send <kbd>⌘ ↵</kbd></button></span></div></div></section>`);
  const chatLogo = document.createElement('img'); chatLogo.className = 'identity-logo'; chatLogo.src = '/assets/logo.png'; chatLogo.alt = 'Habibi';
  resultsView.querySelector('.chat-title .icon')?.replaceWith(chatLogo);
  const messages = document.querySelector('#habibi-messages');
  let attachments = [];
  let pastedAttachmentNumber = 0;
  const renderAttachments = () => {
    const target = document.querySelector('#habibi-attachments');
    setHtml(target, attachments.map((attachment, index) => `<span class="chat-attachment"><i>${attachment.dataUrl && /^image\//.test(attachment.mime) ? `<img src="${safeImageSrc(attachment.dataUrl)}" alt="" />` : icon('file') }</i><b>${escapeHtml(attachment.name)}</b><button data-attachment-index="${index}" aria-label="Remove ${escapeHtml(attachment.name)}">${icon('x')}</button></span>`).join(''));
    target.querySelectorAll('[data-attachment-index]').forEach(button => button.onclick = () => { attachments.splice(Number(button.dataset.attachmentIndex), 1); renderAttachments(); });
    refreshIcons();
  };
  const attachFiles = (files, source = 'file') => {
    const picked = [...files].slice(0, 5 - attachments.length);
    picked.forEach(file => {
      if (file.size > 8 * 1024 * 1024) return notify(`${file.name} is larger than 8 MB`);
      const reader = new FileReader();
      const extension = /^image\//.test(file.type || '') ? (file.type.split('/')[1] || 'png') : 'file';
      const name = file.name || `${source === 'paste' ? 'Pasted image' : 'Attachment'} ${++pastedAttachmentNumber}.${extension}`;
      reader.onload = () => { attachments.push({ name, mime:file.type || 'application/octet-stream', size:file.size, dataUrl:typeof reader.result === 'string' ? reader.result : '' }); renderAttachments(); };
      reader.readAsDataURL(file);
    });
  };
  const attachPastedText = text => {
    const value = String(text || '').trim();
    if (!value) return;
    if (attachments.length >= 5) return notify('You can attach up to five items');
    pastedAttachmentNumber += 1;
    attachments.push({ name:`Pasted note ${pastedAttachmentNumber}.txt`, mime:'text/plain', size:new Blob([value]).size, text:value });
    renderAttachments();
    notify('Large text attached to this message');
  };
  window.__habibiAttachPastedFiles = files => attachFiles(files, 'paste');
  window.__habibiAttachDroppedFiles = files => attachFiles(files, 'drop');
  if (initialAttachments.files?.length) attachFiles(initialAttachments.files, 'paste');
  if (initialAttachments.text) attachPastedText(initialAttachments.text);
  const addTurn = (role, text, turnAttachments = []) => {
    const turn = document.createElement('div');
    const body = document.createElement('div');
    const time = document.createElement('time');
    turn.className = `message ${role === 'user' ? 'outgoing' : 'incoming'}`;
    body.className = 'message-body';
    if (role === 'assistant') setHtml(body, renderAssistantMarkdown(text));
    else body.textContent = text;
    time.textContent = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    turn.append(body);
    if (turnAttachments.length) {
      const tags = document.createElement('div');
      tags.className = 'message-attachment-tags';
      setHtml(tags, turnAttachments.map(attachment => `<span>${/^image\//.test(attachment.mime || '') ? icon('image') : icon(attachment.mime === 'text/plain' ? 'file-text' : 'paperclip')} ${escapeHtml(attachment.name)}</span>`).join(''));
      turn.append(tags);
    }
    turn.append(time);
    if (role === 'assistant') {
      const copy = document.createElement('button');
      copy.className = 'copy-message';
      copy.type = 'button';
      copy.title = 'Copy response';
      copy.setAttribute('aria-label', 'Copy response to clipboard');
      setHtml(copy, `${icon('copy')}<span>Copy</span>`);
      copy.onclick = async () => {
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
          else {
            const temporary = document.createElement('textarea');
            temporary.value = text; temporary.style.position = 'fixed'; temporary.style.opacity = '0';
            document.body.append(temporary); temporary.select();
            const copied = document.execCommand('copy'); temporary.remove();
            if (!copied) throw new Error('Copy failed');
          }
          copy.querySelector('span').textContent = 'Copied';
          setTimeout(() => { if (copy.isConnected) copy.querySelector('span').textContent = 'Copy'; }, 1500);
        } catch (_) { notify('Could not copy that response'); }
      };
      turn.append(copy);
    }
    messages.append(turn);
    messages.scrollTop = messages.scrollHeight;
    saveEphemeralTurn(sessionId, role, text);
    refreshIcons();
  };
  const conversation = [];
  let sending = false;
  const addProposal = (proposal, sourceText) => {
    if (!proposal) return;
    const card = document.createElement('section');
    card.className = 'agent-proposal';
    setHtml(card, `<span class="icon agents">${icon(proposal.kind === 'calendar_draft' ? 'calendar-days' : proposal.kind === 'email_draft' ? 'mail' : 'message-circle-more')}</span><span><b>${escapeHtml(proposal.label)} available</b><small>${escapeHtml(proposal.detail)}</small></span><button type="button">Prepare draft</button>`);
    card.querySelector('button').onclick = () => {
      if (proposal.kind === 'calendar_draft') return showEventDraft(calendarDraftFromText(sourceText));
      if (proposal.kind === 'email_draft') return showMailClient({ compose:true });
      const intent = parseAppIntent(sourceText);
      if (intent?.kind === 'whatsapp') return routeAppIntent(intent);
      notify('Tell Habibi who the message is for to prepare the local draft.');
    };
    messages.append(card); messages.scrollTop = messages.scrollHeight; refreshIcons();
  };
  const addFileCandidates = files => {
    if (!files.length) return;
    const list = document.createElement('div');
    const visualFile = file => /\.(?:avif|gif|jpe?g|png|webp|heic)$/i.test(file.name || '');
    const visualOnly = files.length > 0 && files.every(visualFile);
    list.className = `agent-file-results${visualOnly ? ' agent-file-results--visual' : ''}`;
    setHtml(list, files.map(file => {
      const fileUrl = `/api/file?path=${encodeURIComponent(file.path)}`;
      const preview = visualFile(file)
        ? `<img class="agent-file-thumbnail" src="${safeImageSrc(fileUrl)}" alt="" loading="lazy" />`
        : `<span class="icon files">${icon('file-text')}</span>`;
      return `<button class="agent-file" type="button" draggable="true" data-path="${encodeURIComponent(file.path)}" data-title="${escapeHtml(file.name)}">${preview}<span><b>${escapeHtml(file.name)}</b><small>${escapeHtml(file.folder)} · ${escapeHtml(file.directory)}</small></span><i>${icon('arrow-up-right')}</i></button>`;
    }).join(''));
    list.querySelectorAll('[data-path]').forEach(button => button.onclick = async () => {
      const result = await fetch('/api/open-file', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ path:decodeURIComponent(button.dataset.path) }) }).then(response => response.json()).catch(() => ({ ok:false }));
      notify(result.ok ? 'Opened local file' : 'Could not open that file');
    });
    messages.append(list); messages.scrollTop = messages.scrollHeight; refreshIcons();
  };
  const addAgentTrace = trace => {
    if (!trace?.length) return;
    const panel = document.createElement('details');
    panel.className = 'agent-trace';
    setHtml(panel, `<summary>${icon('route')} Local investigation <span>${trace.length} step${trace.length === 1 ? '' : 's'}</span></summary><ol>${trace.map(step => `<li><span>${icon('check')}</span><span><b>${escapeHtml(step.tool)}</b><small>${escapeHtml(step.detail)}</small></span></li>`).join('')}</ol>`);
    messages.append(panel); messages.scrollTop = messages.scrollHeight; refreshIcons();
  };
  const investigateFiles = async prompt => {
    track('habibi.file-investigation.started', { surface:'assistant', app_type:'native', app_version:'0.1.0' });
    // Finder/TCC may ask for Desktop, Documents, or Downloads while this
    // request is running. Tell the native host first so its ordinary
    // click-away behavior does not dismiss the exact conversation that asked.
    const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
    nativeBridge?.postMessage({ type:'permissionFlow', active:true });
    let result;
    try {
      const response = await fetch('/api/agent/files/investigate', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ history:[...conversation, { role:'user', text:prompt }] }) });
      result = await response.json();
    } finally {
      nativeBridge?.postMessage({ type:'permissionFlow', active:false });
    }
    if (!result.ok || result.phase === 'not_applicable') return false;
    if (result.phase === 'clarify') {
      const question = result.question || 'What detail would help narrow the local search?';
      conversation.push({ role:'user', text:prompt }, { role:'assistant', text:question });
      addAgentTrace(result.trace);
      addTurn('assistant', question);
      track('habibi.file-investigation.completed', { outcome:'clarify', trace_step_count_bucket:countBucket(result.trace?.length || 0), app_type:'native', app_version:'0.1.0' });
      return true;
    }
    const summary = result.summary || 'I searched your local files.';
    conversation.push({ role:'user', text:prompt }, { role:'assistant', text:summary });
    addAgentTrace(result.trace);
    addTurn('assistant', summary);
    addFileCandidates(result.files || []);
    track('habibi.file-investigation.completed', { outcome:(result.files || []).length ? 'results' : 'empty', file_candidate_count_bucket:countBucket((result.files || []).length), trace_step_count_bucket:countBucket(result.trace?.length || 0), app_type:'native', app_version:'0.1.0' });
    return true;
  };
  const respond = async (prompt, pendingAttachments = []) => {
    const pending = document.createElement('div');
    pending.className = 'message incoming thinking';
    setHtml(pending, '<span class="mini-spinner"></span> Thinking…');
    messages.append(pending); messages.scrollTop = messages.scrollHeight;
    try {
      if (!pendingAttachments.length && await investigateFiles(prompt)) { pending.remove(); return; }
      const response = await fetch('/api/llm/chat', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ messages:[...conversation, { role:'user', text:prompt, attachments:pendingAttachments }] }) });
      const data = await response.json();
      pending.remove();
      if (data.needsConfiguration) return showLlmSetup({ afterConfigured:() => showEphemeralHabibiChat(prompt) });
      if (!data.ok) return addTurn('assistant', `I couldn’t reach ${data.provider || 'that model'}: ${data.error}`);
      conversation.push({ role:'user', text:prompt, attachments:pendingAttachments.map(({ name, mime, size }) => ({ name, mime, size })) }, { role:'assistant', text:data.text });
      addTurn('assistant', data.text || 'The model returned an empty response.');
      if (!/^The user approved preparing/i.test(prompt)) addProposal(data.proposal, prompt);
    } catch (_) { pending.remove(); addTurn('assistant', 'I couldn’t reach the configured model. Check Model settings and try again.'); }
  };
  const send = async () => {
    const draft = document.querySelector('#habibi-draft');
    const text = draft.value.trim();
    if (!text && !attachments.length) return;
    if (sending) return;
    const appIntent = !attachments.length && parseAppIntent(text);
    if (appIntent?.kind === 'whatsapp') return routeAppIntent(appIntent);
    const sendButton = document.querySelector('#send-habibi');
    const note = document.querySelector('#habibi-composer-note');
    sending = true;
    if (sendButton) { sendButton.disabled = true; setHtml(sendButton, '<span class="mini-spinner"></span> Sending'); }
    if (note) note.textContent = 'Working locally…';
    try {
      if (!attachments.length && text) {
        const priorUserTurn = [...conversation].reverse().find(turn => turn.role === 'user')?.text || '';
        const routingPending = document.createElement('div');
        routingPending.className = 'message incoming thinking';
        setHtml(routingPending, '<span class="mini-spinner"></span> Preparing that…');
        messages.append(routingPending); messages.scrollTop = messages.scrollHeight;
        try {
          const route = await fetch('/api/agent/route', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ text, context:priorUserTurn }) }).then(response => response.json());
          routingPending.remove();
          if (route.action === 'browser_search' || route.action === 'provider_chat') {
            draft.value = '';
            addTurn('user', text);
            return await openAgentBrowserSearch(route);
          }
        } catch (_) { routingPending.remove(); /* The conversational model remains available as a fallback. */ }
      }
      const pendingAttachments = attachments;
      track('habibi.chat.sent', { surface:'assistant', message_length_bucket:lengthBucket(text), attachment_count_bucket:countBucket(pendingAttachments.length), has_attachments:Boolean(pendingAttachments.length), app_type:'native', app_version:'0.1.0' });
      draft.value = '';
      attachments = []; renderAttachments();
      addTurn('user', text || `Attached ${pendingAttachments.map(item => item.name).join(', ')}`, pendingAttachments);
      await respond(text || 'Please review the attached file(s).', pendingAttachments);
    } finally {
      sending = false;
      const currentButton = document.querySelector('#send-habibi');
      const currentNote = document.querySelector('#habibi-composer-note');
      if (currentButton) { currentButton.disabled = false; setHtml(currentButton, 'Send <kbd>⌘ ↵</kbd>'); }
      if (currentNote) currentNote.textContent = 'This conversation resets when you leave';
      document.querySelector('#habibi-draft')?.focus();
    }
  };
  document.querySelector('#back-habibi').onclick = () => { window.__habibiAttachPastedFiles = null; window.__habibiAttachDroppedFiles = null; showDefault(); };
  document.querySelector('#configure-model').onclick = () => showLlmSetup({ afterConfigured:() => showEphemeralHabibiChat() });
  document.querySelector('#attach-habibi').onclick = () => document.querySelector('#habibi-file-input').click();
  document.querySelector('#habibi-file-input').onchange = event => { attachFiles(event.target.files); event.target.value = ''; };
  document.querySelector('.chat-composer').addEventListener('dragover', event => event.preventDefault());
  document.querySelector('.chat-composer').addEventListener('drop', event => { event.preventDefault(); attachFiles(event.dataTransfer.files); });
  document.querySelector('#habibi-draft').addEventListener('paste', async event => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const hasImage = [...clipboard.types].some(type => /^image\/|^public\.(png|jpeg|tiff)$/i.test(type));
    const hasFile = [...clipboard.items].some(item => item.kind === 'file') || clipboard.files.length > 0;
    const text = clipboard.getData('text/plain');
    const isLargeText = shouldAttachPastedText(text);
    if (hasImage || hasFile || isLargeText) event.preventDefault();
    const files = await pastedImageFiles(clipboard);
    if (files.length || hasImage || hasFile) {
      if (files.length) attachFiles(files, 'paste');
      else if (!requestNativeClipboardImage()) notify('Habibi could not read that image from the clipboard. Try copying the image itself, not its URL.');
      return;
    }
    // Preserve normal paste for a sentence or short instruction. Longer prose
    // becomes an explicit, removable attachment chip, just like WhoDB's input.
    if (shouldAttachPastedText(text)) { event.preventDefault(); attachPastedText(text); }
  });
  document.querySelector('#send-habibi').onclick = send;
  document.querySelector('#habibi-draft').addEventListener('keydown', event => { if (event.metaKey && event.key === 'Enter') send(); });
  refreshIcons();
  fetch('/api/llm/status').then(response => response.json()).then(state => {
    const provider = document.querySelector('#habibi-provider'); const draft = document.querySelector('#habibi-draft'); const sendButton = document.querySelector('#send-habibi'); const note = document.querySelector('#habibi-composer-note');
    if (!state.configured) return showLlmSetup({ afterConfigured:() => showEphemeralHabibiChat(initialPrompt) });
    provider.textContent = `● ${llmProviders[state.provider]?.label || state.provider} · ${state.model}`;
    draft.disabled = false; sendButton.disabled = false; document.querySelector('#attach-habibi').disabled = false; note.textContent = 'This conversation resets when you leave';
    if (initialPrompt.trim()) { addTurn('user', initialPrompt.trim()); requestAnimationFrame(() => respond(initialPrompt.trim())); }
    draft.focus();
  }).catch(() => showLlmSetup({ afterConfigured:() => showEphemeralHabibiChat(initialPrompt) }));
  }

async function showAgenticMessage(command) {
  const match = command.match(/^message\s+(.+?)(?:\s+(?:on\s+)?whatsapp)?\s*[—-]\s*(.+)$/i);
  if (!match) {
    const appIntent = parseAppIntent(command);
    if (appIntent) return routeAppIntent(appIntent);
    // Do not let the launcher bypass Habibi's capability loop. The ephemeral
    // agent first checks local tools (files, mail, calendar, WhatsApp) and
    // only then delegates a genuinely live-web request to the browser router.
    return showEphemeralHabibiChat(command);
  }
  const [, recipient, draft] = match;
  setHtml(resultsView, `<div class="result-header conversation-mode"><b>Habibi</b><span class="verified">● local interpretation</span></div><div class="loading-state"><span class="spinner"></span> Resolving ${escapeHtml(recipient.trim())} in your WhatsApp chats…</div>`);
  fetch('/api/whatsapp/chats').then(response => response.json()).then(data => {
    const needle = recipient.trim().toLowerCase();
    const chat = (data.chats || []).find(item => (item.name || '').toLowerCase() === needle) || (data.chats || []).find(item => (item.name || '').toLowerCase().includes(needle));
    if (!chat) return notify(`No WhatsApp chat found for ${recipient.trim()}`);
    showWhatsAppChat(chat, draft.trim());
  }).catch(() => notify('Could not read your WhatsApp chats'));
}
function parseAppIntent(command = '') {
  const message = command.trim().replace(/[?.!]+$/, '');
  const whatsapp = message.match(/^(?:can\s+you\w*\s+)?(?:ping|message|text|send a message to|reply to)\s+(.+?)(?:\s+(?:on\s+)?whatsapp)?$/i);
  if (whatsapp) return { kind:'whatsapp', target:whatsapp[1].trim(), original:command.trim() };
  if (/\b(?:k8s|kubernetes|kubectl|pods?|deployments?|statefulsets?|daemonsets?|replicasets?|cronjobs?|namespaces?|contexts?|cluster|container|ingress(?:es)?|services?|events?|logs?|crashloop|oomkilled)\b/i.test(message) || (/\bprod(?:uction)?\b/i.test(message) && /\b(?:show|check|find|why|what|status|health)\b/i.test(message))) return { kind:'kubernetes', source:command };
  if (/\b(?:create|schedule|book|add)\b.*\b(?:calendar|meeting|event)\b|\b(?:calendar|meeting|event)\b.*\b(?:create|schedule|book|add)\b/i.test(message) || /\b(?:meeting|meet|appointment|call|lunch|dinner)\b/i.test(message) && /\b(?:next|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s*(?:am|pm)?\s*(?:-|to))\b/i.test(message)) return { kind:'calendar', source:command };
  if (/\b(?:email|gmail|mail)\b/i.test(message) && /\b(?:write|draft|reply|send)\b/i.test(message)) return { kind:'email' };
  return null;
}
function routeAppIntent(intent) {
  if (intent.kind === 'kubernetes') return showKubernetes(intent.source || '');
  if (intent.kind === 'calendar') return showEventDraft(calendarDraftFromText(intent.source || ''));
  if (intent.kind === 'email') return showMailClient({ compose:true });
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden');
  count.textContent = 'WhatsApp · finding chat';
  setHtml(resultsView, `<div class="result-header conversation-mode"><b>WhatsApp</b><span class="verified">● local resolution</span></div><div class="loading-state"><span class="spinner"></span> Finding ${escapeHtml(intent.target)}…</div>`);
  fetch('/api/whatsapp/chats').then(response => response.json()).then(data => {
    const chats = (data.chats || []).filter(chat => chat.kind !== 'status' && !chat.archived);
    const resolved = resolveRecipientIntent(chats, intent.target);
    if (resolved.chat) {
      showWhatsAppChat(resolved.chat);
      if (resolved.instruction) draftWhatsAppMessage(resolved.chat, resolved.instruction, intent.original);
      return;
    }
    showWhatsAppChats();
    setTimeout(() => { input.value = intent.target; filterWhatsAppChats(intent.target); input.focus(); }, 120);
  }).catch(() => notify('Could not read your WhatsApp chats'));
}
function openWebSearch(intent) {
  const providerLabel = intent.provider === 'airbnb' ? 'Airbnb' : intent.provider === 'ChatGPT' ? 'ChatGPT' : intent.provider === 'Claude' ? 'Claude' : intent.provider === 'Gemini' ? 'Gemini' : 'Google';
  fetch('/api/open-url', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ url:intent.url }) })
    .then(response => response.json())
    .then(result => { if (!result.ok) throw new Error('Could not open search'); notify(`Opened ${providerLabel}`); })
    .catch(error => notify(error.message || 'Could not open search'));
  showDefault();
}
function openAgentBrowserSearch(route) {
  if (route.action === 'provider_chat') {
    const provider = route.provider === 'claude' ? 'claude' : route.provider === 'gemini' ? 'gemini' : 'chatgpt';
    const url = provider === 'claude'
      ? `https://claude.ai/new?q=${encodeURIComponent(route.query)}`
      : provider === 'gemini'
        ? `https://gemini.google.com/app?q=${encodeURIComponent(route.query)}`
        : `https://chatgpt.com/?q=${encodeURIComponent(route.query)}`;
    return openWebSearch({ provider:provider === 'chatgpt' ? 'ChatGPT' : provider === 'claude' ? 'Claude' : 'Gemini', url });
  }
  const params = new URLSearchParams({ query:route.query });
  if (route.checkin) params.set('checkin', route.checkin);
  if (route.checkout) params.set('checkout', route.checkout);
  if (route.adults) params.set('adults', String(route.adults));
  const url = route.provider === 'airbnb'
    ? `https://www.airbnb.co.uk/s/homes?${params.toString()}`
    : `https://www.google.com/search?q=${encodeURIComponent(route.query)}`;
  return openWebSearch({ provider:route.provider, url });
}
function resolveRecipientIntent(chats, target) {
  const lowerTarget = target.toLowerCase().trim();
  const matches = chats.map(chat => ({ chat, name:(chat.name || '').trim() })).filter(item => item.name && lowerTarget.startsWith(item.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length);
  if (matches[0]) return { chat:matches[0].chat, instruction:target.slice(matches[0].name.length).replace(/^(?:\s*(?:about|saying|that|to say)\s*)/i, '').trim() };
  const exact = chats.find(chat => (chat.name || '').toLowerCase() === lowerTarget) || chats.find(chat => (chat.name || '').toLowerCase().includes(lowerTarget));
  return { chat:exact, instruction:'' };
}
function draftWhatsAppMessage(chat, instruction, originalRequest) {
  const composer = document.querySelector('#message-draft');
  if (!composer) return;
  const sendButton = document.querySelector('#send-message');
  composer.placeholder = 'Drafting in your tone…'; composer.disabled = true; if (sendButton) sendButton.disabled = true;
  fetch('/api/llm/status').then(response => response.json())
    .then(state => {
      if (!state.configured) throw new Error('Set up a model to create a draft');
      const prompt = `Draft one short message from this anonymized instruction: “${instruction}”. Preserve the language, script, and lingo used in that instruction; Hinglish or any other language is fine. Do not infer or include names, contact details, chat history, or personal facts. Do not invent facts. Output only the message draft—no explanation, greeting label, or quotation marks.`;
      return fetch('/api/llm/chat', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ messages:[{ role:'user', text:prompt }] }) });
    }).then(response => response.json()).then(data => {
      if (!data.ok) throw new Error(data.error || 'Could not create a draft');
      if (document.querySelector('#message-draft')) { composer.value = data.text.trim(); composer.placeholder = 'Write a message…'; composer.disabled = false; if (sendButton) sendButton.disabled = false; composer.focus(); notify('Draft ready — review before sending'); }
    }).catch(error => { if (document.querySelector('#message-draft')) { composer.placeholder = 'Write a message…'; composer.disabled = false; if (sendButton) sendButton.disabled = false; composer.focus(); } notify(error.message || 'Could not create a draft'); });
}
function showWhatsAppChats() {
  launcherMode = 'whatsapp';
  input.value = '';
  input.placeholder = 'Search WhatsApp chats…';
  // Returning from a chat removes the focused composer from the DOM. Move focus
  // back to the persistent command input so arrows and typing keep working.
  requestAnimationFrame(() => input.focus({ preventScroll:true }));
  setHtml(resultsView, `<div class="result-header conversation-mode"><b>WhatsApp</b><span class="verified">● local session</span></div><div class="loading-state"><span class="spinner"></span> Loading your chats…</div>`);
  Promise.all([fetch('/api/whatsapp/chats').then(response => response.json()), loadLocalContacts()]).then(([data]) => {
    const chats = (data.chats || []).filter(chat => chat.kind !== 'status' && !chat.archived).map(enrichChatWithLocalContact).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 100);
    if (!data.ok) throw new Error(data.error);
    setHtml(resultsView, `<div class="result-header conversation-mode"><b>WhatsApp</b><span class="verified">● ${chats.length} recent chats</span></div><div class="result-list" data-whatsapp-list>${chats.map((chat, index) => resultButton({ icon:'whatsapp', title:chat.name || chat.id, meta:chat.lastMessage || 'Open chat', tag:'CHAT', type:'chat', chat, timestamp:chat.timestamp, unread:chat.unreadCount, avatar:chat.avatar, initials:initials(chat.name || chat.id), showChatAvatar:true }, index)).join('')}</div>`);
    const pictureIds = chats.slice(0, 12).map(chat => chat.id).join(',');
    let avatarAttempts = 0;
    const hydrateAvatars = () => {
      const list = resultsView.querySelector('[data-whatsapp-list]');
      // The user may have navigated away while profile pictures were in flight.
      // Never let that asynchronous work modify global search results.
      if (launcherMode !== 'whatsapp' || !list) return;
      return fetch(`/api/whatsapp/profile-pictures?ids=${encodeURIComponent(pictureIds)}`).then(response => response.json()).then(data => {
      if (launcherMode !== 'whatsapp' || !list.isConnected) return;
      const pictures = data.pictures?.pictures || data.pictures || {};
      chats.forEach((chat, index) => {
        const picture = pictures[chat.id] || pictures.find?.(item => item.id === chat.id)?.url;
        const iconNode = list.querySelectorAll('.result .icon')[index];
        if (picture && iconNode && !iconNode.querySelector('img')) replaceHtml(iconNode, `<span class="icon chat-avatar"><img src="${safeImageSrc(picture)}" alt="" /></span>`);
      });
      if (++avatarAttempts < 4 && launcherMode === 'whatsapp' && list.isConnected) setTimeout(hydrateAvatars, 3500);
      }).catch(() => {});
    };
    hydrateAvatars();
    refreshIcons();
  }).catch(error => { setHtml(resultsView, `<div class="local-files-empty">${error.message || 'Could not load WhatsApp chats.'}</div>`); });
}

function contactDigits(value = '') { return String(value).replace(/\D/g, ''); }
function enrichChatWithLocalContact(chat) {
  const name = String(chat.name || '').trim();
  if (!/^\+?\d[\d\s()-]{6,}$/.test(name)) return chat;
  const number = contactDigits(chat.id || name);
  const localName = localContactNames.get(number) || (number.length >= 10 ? [...localContactNames.entries()].find(([phone]) => phone.slice(-10) === number.slice(-10))?.[1] : '');
  return localName ? { ...chat, name:localName } : chat;
}
function loadLocalContacts() {
  const bridge = window.webkit?.messageHandlers?.habibiNative;
  if (!bridge || localContactsRequested) return Promise.resolve(localContactNames);
  localContactsRequested = true;
  return new Promise(resolve => {
    const timeout = setTimeout(() => { window.__habibiNativeContacts = null; resolve(localContactNames); }, 10_000);
    window.__habibiNativeContacts = payload => {
      clearTimeout(timeout); window.__habibiNativeContacts = null;
      if (payload?.ok) localContactNames = new Map((payload.contacts || []).map(contact => [contact.phone, contact.name]));
      resolve(localContactNames);
    };
    bridge.postMessage({ type:'contacts' });
  });
}
function filterWhatsAppChats(query) {
  const needle = query.toLowerCase();
  resultsView.querySelector('.contact-search-section')?.remove();
  const rows = [...resultsView.querySelectorAll('.result')];
  rows.forEach(row => {
    const chat = row.dataset.chat ? JSON.parse(decodeURIComponent(row.dataset.chat)) : { name:row.dataset.title };
    row.hidden = Boolean(needle) && !chatIntentFromSearch(chat, query);
    row.classList.remove('selected');
  });
  const first = rows.find(row => !row.hidden);
  if (first) first.classList.add('selected');
  count.textContent = `${rows.filter(row => !row.hidden).length} chats`;
  if (needle.length < 2) return;
  const sequence = ++contactSearchSequence;
  const contactQuery = query.split(/\s+/).find(token => token.length >= 3) || query;
  fetch(`/api/whatsapp/contacts?q=${encodeURIComponent(contactQuery)}`).then(response => response.json()).then(data => {
    if (sequence !== contactSearchSequence || input.value.trim() !== query || !data.ok) return;
    const contacts = (data.contacts || []).map(contact => ({ id:contact.id, name:contact.name || contact.pushName || contact.notify || contact.id }));
    const existing = new Set(rows.filter(row => !row.hidden).map(row => row.dataset.title.toLowerCase()));
    const additional = contacts.filter(contact => !existing.has(contact.name.toLowerCase()));
    if (!additional.length) return;
    resultsView.insertAdjacentHTML('beforeend', `<section class="contact-search-section inline-section"><div class="result-header"><b>Contacts</b><span>WhatsApp address book</span></div><div class="result-list">${additional.map((contact, index) => resultButton({ icon:'whatsapp', title:contact.name, meta:'WhatsApp contact · open conversation', tag:'CONTACT', type:'chat', chat:contact, initials:initials(contact.name), showChatAvatar:true }, index)).join('')}</div></section>`);
    const contactRows = [...resultsView.querySelectorAll('.contact-search-section .result')];
    contactRows.forEach(row => row.classList.remove('selected'));
    if (!first && contactRows[0]) contactRows[0].classList.add('selected');
    count.textContent = `${rows.filter(row => !row.hidden).length + contactRows.length} matches`;
    refreshIcons();
  }).catch(() => {});
}
function chatIntentFromSearch(chat, query = '') {
  const name = String(chat.name || chat.pushName || chat.notify || '').trim();
  const words = query.trim().split(/\s+/).filter(Boolean);
  const nameWords = name.toLowerCase().split(/\s+/).filter(word => word.length >= 3);
  const matched = words.map((word, index) => ({ word, index })).filter(({ word }) => {
    const value = word.toLowerCase();
    return nameWords.includes(value) || (value.length >= 3 && nameWords.some(nameWord => nameWord.startsWith(value)));
  });
  if (!matched.length) return null;
  const used = new Set(matched.map(item => item.index));
  const instruction = words.filter((_, index) => !used.has(index)).join(' ').replace(/^(?:that|saying|say|to\s+say)\s+/i, '').trim();
  return { instruction, matchCount:matched.length };
}
function whatsappMediaMarkup(message) {
  const media = message.metadata?.media;
  const type = message.type || 'unknown';
  const mime = /^[\w.+/-]+$/.test(String(media?.mimetype || '')) ? media.mimetype : '';
  // `media.data` is connector-supplied base64. Build the URL, then let the
  // shared guard validate the whole thing rather than trusting the parts.
  const source = media?.data && mime ? safeMediaSrc(`data:${mime};base64,${media.data}`) : '';
  const filename = escapeHtml(media?.filename || message.body || (type === 'document' ? 'Document' : 'Media'));
  if (source && type === 'image') return `<div class="media-card image-media"><img src="${source}" alt="Image message" loading="lazy" /></div>`;
  if (source && type === 'video') return `<div class="media-card video-media"><video controls preload="metadata" src="${source}"></video><span>${icon('video')} Video</span></div>`;
  if (source && (type === 'audio' || type === 'voice')) return `<div class="media-card audio-media"><span class="media-glyph">${icon('mic')}</span><audio controls src="${source}"></audio></div>`;
  if (type === 'document') return `<a class="media-card document-media" href="${source || '#'}" ${source ? `download="${filename}"` : ''}><span class="media-glyph">${icon(mime === 'application/pdf' ? 'file-text' : 'file')}</span><span><b>${filename}</b><small>${mime === 'application/pdf' ? 'PDF document' : 'Document'}${source ? ' · Download' : ''}</small></span></a>`;
  if (type !== 'text') return `<div class="media-card generic-media"><span class="media-glyph">${icon(type === 'video' ? 'video' : type === 'image' ? 'image' : 'paperclip')}</span><span><b>${escapeHtml(type === 'unknown' ? 'Media message' : `${type[0].toUpperCase()}${type.slice(1)} message`)}</b><small>${escapeHtml(message.body || 'Open in WhatsApp')}</small></span></div>`;
  return `<span>${escapeHtml(message.body || message.text || message.content || '')}</span>`;
}
function showWhatsAppChat(chat, draft = '') {
  const avatar = chat.avatar ? `<img src="${safeImageSrc(chat.avatar)}" alt="" />` : `<span>${escapeHtml(initials(chat.name || chat.id))}</span>`;
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-chats">${icon('arrow-left')} WhatsApp</button><span class="verified">● local session</span></div><section class="chat-client whatsapp-client"><div class="chat-title"><span class="icon chat-avatar" id="chat-avatar">${avatar}</span><span><b>${escapeHtml(chat.name || chat.id)}</b><small>Loading recent history…</small></span></div><div class="messages"><div class="loading-state"><span class="spinner"></span> Loading messages…</div></div><div class="chat-composer"><div id="whatsapp-attachments" class="chat-attachments"></div><textarea id="message-draft" rows="2" placeholder="Write a message…">${escapeHtml(draft)}</textarea><input id="whatsapp-file-input" type="file" multiple hidden /><div><span id="whatsapp-composer-note">Only sent after you confirm</span><span class="composer-actions"><button type="button" class="composer-icon" id="attach-whatsapp" title="Attach files" aria-label="Attach files">${icon('paperclip')}</button><button type="button" class="primary" id="send-message">Send <kbd>⌘ ↵</kbd></button></span></div></div></section>`);
  document.querySelector('#back-chats').onclick = () => { window.__habibiAttachDroppedFiles = null; showWhatsAppChats(); };
  let attachments = [];
  const renderAttachments = () => {
    const target = document.querySelector('#whatsapp-attachments');
    if (!target) return;
    setHtml(target, attachments.map((attachment, index) => `<span class="chat-attachment"><i>${/^image\//.test(attachment.mime) ? `<img src="${safeImageSrc(attachment.dataUrl)}" alt="" />` : icon('file')}</i><b>${escapeHtml(attachment.name)}</b><button type="button" data-whatsapp-attachment-index="${index}" aria-label="Remove ${escapeHtml(attachment.name)}">${icon('x')}</button></span>`).join(''));
    target.querySelectorAll('[data-whatsapp-attachment-index]').forEach(button => button.onclick = () => { attachments.splice(Number(button.dataset.whatsappAttachmentIndex), 1); renderAttachments(); });
    refreshIcons();
  };
  const attachFiles = files => {
    const picked = [...files].slice(0, 5 - attachments.length);
    for (const file of picked) {
      if (file.size > 6 * 1024 * 1024) { notify(`${file.name} is larger than 6 MB`); continue; }
      if (attachments.reduce((total, item) => total + item.size, 0) + file.size > 6 * 1024 * 1024) { notify('Attachments are limited to 6 MB per message'); break; }
      const reader = new FileReader();
      reader.onload = () => { attachments.push({ name:file.name || 'Attachment', mime:file.type || 'application/octet-stream', size:file.size, dataUrl:typeof reader.result === 'string' ? reader.result : '' }); renderAttachments(); };
      reader.readAsDataURL(file);
    }
  };
  // Finder drops reach the native WKWebView host first. It turns those paths
  // back into browser File objects through our loopback-only file endpoint so
  // the rest of the composer follows the exact same validation/send path as a
  // file chosen with the paperclip.
  window.__habibiAttachDroppedFiles = files => attachFiles(files);
  const renderMessages = messages => { const box = document.querySelector('.messages'); const ordered = [...(messages || [])].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)).slice(-24); setHtml(box, ordered.map(message => `<div class="message ${message.direction === 'outgoing' ? 'outgoing' : 'incoming'} ${message.metadata?.media ? 'has-media' : ''}">${whatsappMediaMarkup(message)}<time>${message.timestamp ? new Date(message.timestamp * 1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : ''}</time></div>`).join('') || '<div class="local-files-empty">No recent messages yet.</div>'); const subtitle = document.querySelector('.chat-title small'); if (subtitle) subtitle.textContent = ordered.length ? `${ordered.length} recent messages · WhatsApp` : 'No recent messages'; const scrollToLatest = () => { box.scrollTop = box.scrollHeight; }; requestAnimationFrame(scrollToLatest); box.querySelectorAll('img').forEach(media => media.complete ? requestAnimationFrame(scrollToLatest) : media.addEventListener('load', scrollToLatest, { once:true })); box.querySelectorAll('video').forEach(media => media.addEventListener('loadedmetadata', scrollToLatest, { once:true })); };
  fetch(`/api/whatsapp/history?chatId=${encodeURIComponent(chat.id)}`).then(response => response.json()).then(data => { if (!data.ok) throw new Error(data.error); renderMessages(data.messages); }).catch(error => { setHtml(document.querySelector('.messages'), `<div class="local-files-empty">${error.message || 'Could not load messages.'}</div>`); });
  let avatarAttempts = 0;
  const hydrateAvatar = () => fetch(`/api/whatsapp/profile-pictures?ids=${encodeURIComponent(chat.id)}`).then(response => response.json()).then(data => {
    const pictures = data.pictures?.pictures || data.pictures || {};
    const picture = pictures[chat.id] || pictures.find?.(item => item.id === chat.id)?.url;
    const avatarNode = document.querySelector('#chat-avatar');
    if (picture && avatarNode && avatarNode.querySelector('img')?.getAttribute('src') !== picture) setHtml(avatarNode, `<img src="${safeImageSrc(picture)}" alt="" />`);
    if (++avatarAttempts < 4 && document.querySelector('#chat-avatar')) setTimeout(hydrateAvatar, 2000);
  }).catch(() => {});
  hydrateAvatar();
  const send = async () => {
    const composer = document.querySelector('#message-draft');
    const text = composer.value.trim();
    if (!text && !attachments.length) return notify('Write a message or attach a file first');
    const box = document.querySelector('.messages');
    const message = document.createElement('div');
    const body = document.createElement('span');
    const time = document.createElement('time');
    message.className = 'message outgoing sending';
    body.textContent = text || `Attached ${attachments.map(attachment => attachment.name).join(', ')}`;
    time.textContent = 'Sending…';
    message.append(body, time);
    if (attachments.length) {
      const tags = document.createElement('div');
      tags.className = 'message-attachment-tags';
      setHtml(tags, attachments.map(attachment => `<span>${icon(/^image\//.test(attachment.mime) ? 'image' : 'paperclip')} ${escapeHtml(attachment.name)}</span>`).join(''));
      message.append(tags);
    }
    box.append(message);
    box.scrollTop = box.scrollHeight;
    const pendingAttachments = attachments;
    composer.value = '';
    attachments = []; renderAttachments();
    composer.focus();
    let approvalToken;
    const approvalPayload = { chatId:chat.id, text, attachments:pendingAttachments.map(({ name, mime, size }) => ({ name, mime, bytes:size })) };
    try { approvalToken = await requestApproval('whatsapp.send', approvalPayload); }
    catch (error) { message.remove(); composer.value = text; attachments = pendingAttachments; renderAttachments(); return notify(error.message); }
    fetch('/api/whatsapp/send', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ chatId:chat.id, text, attachments:pendingAttachments, approvalToken }) })
      .then(response => response.json())
      .then(result => {
        if (!result.ok) throw new Error(result.error);
        message.classList.remove('sending');
        time.textContent = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        notify(`Message sent to ${chat.name || 'chat'}`);
      })
      .catch(error => {
        message.classList.add('failed');
        time.textContent = 'Not sent';
        composer.value = text;
        attachments = pendingAttachments; renderAttachments();
        notify(error.message || 'Could not send message');
      });
  };
  document.querySelector('#send-message').onclick = send;
  document.querySelector('#attach-whatsapp').onclick = () => document.querySelector('#whatsapp-file-input').click();
  document.querySelector('#whatsapp-file-input').onchange = event => { attachFiles(event.target.files); event.target.value = ''; };
  document.querySelector('.whatsapp-client .chat-composer').addEventListener('dragover', event => event.preventDefault());
  document.querySelector('.whatsapp-client .chat-composer').addEventListener('drop', event => { event.preventDefault(); attachFiles(event.dataTransfer.files); });
  document.querySelector('#message-draft').addEventListener('paste', event => {
    const files = event.clipboardData?.files;
    if (!files?.length) return;
    event.preventDefault();
    attachFiles(files);
  });
  document.querySelector('#message-draft').addEventListener('keydown', event => { if (event.metaKey && event.key === 'Enter') send(); });
  refreshIcons();
  requestAnimationFrame(() => document.querySelector('#message-draft')?.focus());
}
function showAgentDock() {
  return showAgentSessions();
}
function showAgentSessions(kind = '') {
  closeInteractiveTerminal();
  launcherMode = 'agent-sessions';
  input.value = ''; input.placeholder = kind ? `Filter ${kind === 'codex' ? 'Codex' : 'Claude Code'} sessions…` : 'Filter Codex and Claude sessions…';
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = `${kind ? (kind === 'codex' ? 'Codex' : 'Claude Code') : 'Agent'} sessions · local`;
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-agent-dock">${icon('arrow-left')} Habibi</button><span class="verified">● local transcripts</span></div><section class="agent-sessions-plugin"><div class="agent-sessions-heading"><span class="icon agents">${icon(kind === 'claude' ? 'sparkles' : kind === 'codex' ? 'braces' : 'bot')}</span><span><b>${kind === 'claude' ? 'Claude Code' : kind === 'codex' ? 'Codex' : 'Codex & Claude Code'}</b><small>Local sessions, transcripts, and exact-session resume. Nothing is uploaded.</small></span></div><div class="agent-session-tabs"><button class="${!kind ? 'selected' : ''}" data-agent-session-kind="">All</button><button class="${kind === 'codex' ? 'selected' : ''}" data-agent-session-kind="codex">Codex</button><button class="${kind === 'claude' ? 'selected' : ''}" data-agent-session-kind="claude">Claude</button></div><div id="agent-dock" class="agent-dock">${kubernetesLoading('Reading local sessions', 'Scanning Codex and Claude Code transcript indexes.')}</div></section>`);
  document.querySelector('#back-agent-dock').onclick = showDefault;
  const load = query => fetch(`/api/agent-sessions?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(query || '')}`).then(response => response.json()).then(data => {
    const dock = document.querySelector('#agent-dock');
    if (!dock) return;
    if (!data.ok) throw new Error('Unavailable');
    if (!data.sessions.length) {
      setHtml(dock, `<div class="clear-day"><span class="icon agents">${icon('bot')}</span><span><b>No matching local sessions.</b><small>Habibi reads the local Codex and Claude Code transcript stores only.</small></span></div>`);
    } else {
      setHtml(dock, data.sessions.map((session, index) => `<button class="agent-session ${index === 0 ? 'selected' : ''}" data-agent-session="${encodeURIComponent(JSON.stringify(session))}"><span class="icon agents">${icon(session.kind === 'claude' ? 'sparkles' : 'braces')}</span><span><b>${escapeHtml(session.title)}</b><small>${session.kind === 'claude' ? 'Claude Code' : 'Codex'} · ${new Date(session.updatedAt).toLocaleString()}</small><code>${escapeHtml(session.cwd || 'Project directory unavailable')}</code></span><i data-lucide="chevron-right"></i></button>`).join(''));
      dock.querySelectorAll('[data-agent-session]').forEach(button => button.onclick = () => showAgentSessionDetail(JSON.parse(decodeURIComponent(button.dataset.agentSession))));
    }
    refreshIcons();
  }).catch(() => { const dock = document.querySelector('#agent-dock'); if (dock) setHtml(dock, '<div class="searching-local">Local agent sessions are unavailable right now.</div>'); });
  resultsView.querySelectorAll('[data-agent-session-kind]').forEach(button => button.onclick = () => showAgentSessions(button.dataset.agentSessionKind));
  load();
  input.oninput = () => { clearTimeout(commandSearchTimer); commandSearchTimer = setTimeout(() => load(input.value), 180); };
  requestAnimationFrame(() => input.focus({ preventScroll:true }));
}
async function showAgentSessionDetail(session) {
  const label = session.kind === 'claude' ? 'Claude Code' : 'Codex';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-agent-session">${icon('arrow-left')} ${label} sessions</button><span class="verified">● local transcript</span></div><section class="agent-transcript"><div class="loading-state"><span class="spinner"></span> Reading this local session…</div></section>`);
  document.querySelector('#back-agent-session').onclick = () => showAgentSessions(session.kind);
  try {
    const response = await fetch('/api/agent-sessions/detail', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ id:session.id, kind:session.kind }) });
    const data = await response.json(); if (!data.ok) throw new Error(data.error || 'Could not read this session.');
    const transcript = data.transcript || [];
    setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-agent-session">${icon('arrow-left')} ${label} sessions</button><span class="verified">● local transcript</span></div><section class="agent-transcript"><header><span class="icon agents">${icon(session.kind === 'claude' ? 'sparkles' : 'braces')}</span><span><b>${escapeHtml(data.session.title)}</b><small>${escapeHtml(data.session.cwd || 'Project directory unavailable')} · ${new Date(data.session.updatedAt).toLocaleString()}</small></span><button class="primary" id="resume-specific-session">${icon('terminal-square')} Resume <kbd>↵</kbd></button></header><div class="agent-transcript-scroll">${transcript.map(entry => `<article class="agent-transcript-entry ${escapeHtml(entry.role)}"><small>${entry.role === 'tool' ? 'Tool' : entry.role === 'assistant' ? label : 'You'}${entry.at ? ` · ${new Date(entry.at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}` : ''}</small><pre>${escapeHtml(entry.text)}</pre></article>`).join('') || '<div class="local-files-empty">No readable messages in this session.</div>'}</div></section>`);
    document.querySelector('#back-agent-session').onclick = () => showAgentSessions(session.kind);
    document.querySelector('#resume-specific-session').onclick = () => showInteractiveTerminal({ cwd:data.session.cwd, sessionId:data.session.id }, session.kind, label);
    refreshIcons();
  } catch (error) { setHtml(resultsView, `<div class="local-files-empty">${escapeHtml(error.message || 'Could not read this local session.')}</div>`); }
}
function showAgentDetail(agent) {
  const kind = /claude/i.test(agent.command) ? 'claude' : 'codex';
  const label = kind === 'claude' ? 'Claude Code' : 'Codex';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-agents">${icon('arrow-left')} Agent Dock</button><span class="verified">● running locally</span></div><section class="agent-detail"><div class="agent-detail-title"><span class="icon agents">${icon('bot')}</span><span><b>${escapeHtml(label)}</b><small>PID ${escapeHtml(agent.pid)} · active for ${escapeHtml(agent.elapsed)}</small></span></div><div class="agent-context"><span>PROJECT</span><code>${escapeHtml(agent.cwd || 'Project directory unavailable')}</code></div><div class="agent-context"><span>COMMAND</span><code>${escapeHtml(agent.command)}</code></div><div class="agent-detail-actions"><button class="secondary" id="open-project">${icon('folder-open')} Open project</button><button class="primary" id="resume-agent">${icon('terminal-square')} Open interactive session</button></div><p class="agent-disclaimer">Starts a Habibi-owned local PTY in this project, then opens the ${label} resume picker. Your input and output stay on this Mac.</p></section>`);
  document.querySelector('#back-agents').onclick = showAgentDock;
  const run = async (endpoint, success) => {
    if (!agent.cwd) return notify('Project directory is unavailable for this process');
    const response = await fetch(endpoint, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ cwd:agent.cwd, kind }) });
    const result = await response.json();
    notify(result.ok ? success : 'Could not open the local project');
  };
  document.querySelector('#open-project').onclick = () => run('/api/agents/open-project', 'Opened project in Finder');
  document.querySelector('#resume-agent').onclick = () => { if (!agent.cwd) return notify('Project directory is unavailable for this process'); showInteractiveTerminal(agent, kind, label); };
  refreshIcons();
}
function closeInteractiveTerminal() {
  terminalResizeObserver?.disconnect(); terminalResizeObserver = null;
  activeTerminalSocket?.close(); activeTerminalSocket = null;
  activeTerminal?.dispose(); activeTerminal = null;
}
function loadTerminalAsset(tag, attributes) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`[data-habibi-terminal-asset="${attributes.href || attributes.src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') resolve();
      else { existing.addEventListener('load', resolve, { once:true }); existing.addEventListener('error', reject, { once:true }); }
      return;
    }
    const element = document.createElement(tag);
    Object.assign(element, attributes);
    element.dataset.habibiTerminalAsset = attributes.href || attributes.src;
    element.addEventListener('load', () => { element.dataset.loaded = 'true'; resolve(); }, { once:true });
    element.addEventListener('error', () => reject(new Error('Terminal renderer unavailable.')), { once:true });
    document.head.append(element);
  });
}
function ensureTerminalAssets() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (terminalAssetsPromise) return terminalAssetsPromise;
  const styles = loadTerminalAsset('link', { rel:'stylesheet', href:'/vendor/xterm.css' });
  terminalAssetsPromise = Promise.all([styles, loadTerminalAsset('script', { src:'/vendor/xterm.js' })])
    .then(() => loadTerminalAsset('script', { src:'/vendor/xterm-fit.js' }))
    .then(() => { if (!window.Terminal || !window.FitAddon) throw new Error('Terminal renderer unavailable.'); })
    .catch(error => { terminalAssetsPromise = null; throw error; });
  return terminalAssetsPromise;
}
async function showInteractiveTerminal(agent, kind, label) {
  closeInteractiveTerminal();
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-agent-detail">${icon('arrow-left')} ${label}</button><span class="verified">● interactive local PTY</span></div><section class="terminal-shell"><header><span>${icon('terminal-square')} ${escapeHtml(label)} · ${escapeHtml(agent.cwd)}</span><button id="close-terminal">End session</button></header><div id="terminal-host" aria-label="Interactive ${label} terminal"></div><footer><span>Type normally. <kbd>ctrl c</kbd> interrupts · session ends when you close it.</span><span id="terminal-status">Connecting…</span></footer></section>`);
  document.querySelector('#back-agent-detail').onclick = () => { closeInteractiveTerminal(); showAgentDetail(agent); };
  document.querySelector('#close-terminal').onclick = () => { closeInteractiveTerminal(); showAgentDetail(agent); };
  const host = document.querySelector('#terminal-host');
  host.textContent = 'Loading terminal renderer…';
  refreshIcons();
  try { await ensureTerminalAssets(); }
  catch (error) { if (host.isConnected) host.textContent = error.message || 'Terminal renderer unavailable.'; return; }
  if (!host.isConnected) return;
  host.textContent = '';
  activeTerminal = new window.Terminal({ cursorBlink:true, fontFamily:'"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace', fontSize:12, theme:{ background:'#162B4A', foreground:'#FAF5EC', cursor:'#F4781C', selectionBackground:'#1C3B6D' } });
  const fit = new window.FitAddon.FitAddon(); activeTerminal.loadAddon(fit); activeTerminal.open(host); fit.fit();
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  activeTerminalSocket = new WebSocket(`${protocol}://${window.location.host}/pty`);
  const resize = () => { if (!activeTerminalSocket || activeTerminalSocket.readyState !== WebSocket.OPEN) return; fit.fit(); activeTerminalSocket.send(JSON.stringify({ type:'resize', cols:activeTerminal.cols, rows:activeTerminal.rows })); };
  terminalResizeObserver = new ResizeObserver(resize); terminalResizeObserver.observe(host);
  activeTerminalSocket.onopen = () => { activeTerminalSocket.send(JSON.stringify({ type:'start', cwd:agent.cwd, kind, sessionId:agent.sessionId || '' })); resize(); };
  activeTerminalSocket.onmessage = event => { const message = JSON.parse(event.data); if (message.type === 'data') activeTerminal.write(message.data); if (message.type === 'started') document.querySelector('#terminal-status').textContent = 'Running'; if (message.type === 'exit') document.querySelector('#terminal-status').textContent = `Exited (${message.exitCode})`; if (message.type === 'error') activeTerminal.write(`\r\nError: ${message.message}\r\n`); };
  activeTerminalSocket.onclose = () => { const status = document.querySelector('#terminal-status'); if (status && status.textContent === 'Connecting…') status.textContent = 'Disconnected'; };
  activeTerminal.onData(data => activeTerminalSocket?.readyState === WebSocket.OPEN && activeTerminalSocket.send(JSON.stringify({ type:'input', data })));
  setTimeout(() => { resize(); activeTerminal.focus(); }, 50);
}
function localDateTime(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function showEventDraft(existing) {
  const start = new Date();
  start.setDate(start.getDate() + 1); start.setHours(12, 30, 0, 0);
  const eventStart = existing ? new Date(existing.start) : start;
  const eventEnd = existing ? new Date(existing.end) : new Date(start.getTime() + 60 * 60 * 1000);
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = 'Calendar · draft';
  setHtml(resultsView, `<div class="result-header conversation-mode"><b>Create event</b><span class="verified">● reviewed before save</span></div>
    <section class="event-draft"><div class="event-title"><span class="icon calendar">${icon('calendar-days')}</span><input id="event-title" value="${escapeHtml(existing ? existing.title : '')}" placeholder="Event title" aria-label="Event title" /></div><div class="event-field"><label>Starts</label><input id="event-start" type="datetime-local" value="${localDateTime(eventStart)}" /></div><div class="event-field"><label>Ends</label><input id="event-end" type="datetime-local" value="${localDateTime(eventEnd)}" /></div><div class="event-field"><label>Calendar</label><select id="event-calendar"><option>Loading calendars…</option></select></div><div class="event-note"><i data-lucide="shield-check"></i> ${existing ? 'Changes save only after you confirm.' : 'This creates one event only after you confirm.'}</div><div class="event-actions"><button class="secondary" id="cancel-event">Cancel</button><button class="primary" id="create-event">${existing ? 'Save changes' : 'Create event'} <kbd>⌘ ↵</kbd></button></div></section>`);
  fetch('/api/calendars').then(response => response.json()).then(data => {
    const select = document.querySelector('#event-calendar');
    if (!select) return;
    const names = data.ok && data.calendars.length ? data.calendars : ['Calendar'];
    setHtml(select, names.map(name => `<option ${existing && name === existing.calendar ? 'selected' : ''}>${escapeHtml(name)}</option>`).join(''));
  }).catch(() => { const select = document.querySelector('#event-calendar'); if (select) setHtml(select, '<option>Calendar</option>'); });
  document.querySelector('#cancel-event').onclick = showDefault;
  document.querySelector('#create-event').onclick = async () => {
    const title = document.querySelector('#event-title').value.trim();
    const calendar = document.querySelector('#event-calendar').value;
    const startDate = new Date(document.querySelector('#event-start').value);
    const endDate = new Date(document.querySelector('#event-end').value);
    if (!title || Number.isNaN(startDate.valueOf()) || endDate <= startDate) return notify('Check the event details');
    const endpoint = existing ? '/api/calendar/event/update' : '/api/calendar/event';
    // The bound payload must mirror exactly what the route validates: create has
    // no id, update has one.
    const event = { title, calendar, start:startDate.toISOString(), end:endDate.toISOString() };
    if (existing) event.id = String(existing.id || '');
    let approvalToken;
    try { approvalToken = await requestApproval(existing ? 'calendar.update' : 'calendar.create', event); }
    catch (error) { return notify(error.message); }
    const response = await fetch(endpoint, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ ...event, approvalToken }) });
    const result = await response.json();
    notify(result.ok ? (existing ? `Updated “${title}”` : `Created “${title}”`) : 'Calendar permission or save failed');
    if (result.ok) showDefault();
  };
  refreshIcons();
}
function showUpcomingEvents() {
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = 'Calendar · upcoming';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-upcoming-events">${icon('arrow-left')} Habibi</button><span class="verified">● next 14 days</span></div><div class="agenda-list"><div class="loading-state"><span class="spinner"></span> Loading your calendar…</div></div>`);
  document.querySelector('#back-upcoming-events').onclick = showDefault;
  loadCalendarEvents().then(data => {
    const list = document.querySelector('.agenda-list');
    if (!list) return;
    if (!data.ok) return setHtml(list, '<div class="searching-local">Calendar access is needed to show upcoming events.</div>');
    setHtml(list, data.events.length ? data.events.map(event => `<button class="agenda-event" data-event="${encodeURIComponent(JSON.stringify(event))}"><span class="icon calendar">${icon('calendar-days')}</span><span><b>${escapeHtml(event.title || 'Untitled event')}</b><small>${escapeHtml(new Date(event.start).toLocaleString([], { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }))} · ${escapeHtml(event.calendar)}</small></span><i data-lucide="chevron-right"></i></button>`).join('') : '<div class="searching-local">No events in the next 14 days.</div>');
    list.querySelectorAll('.agenda-event').forEach(button => button.onclick = () => showEventDraft(JSON.parse(decodeURIComponent(button.dataset.event))));
    refreshIcons();
  }).catch(() => { const list = document.querySelector('.agenda-list'); if (list) setHtml(list, '<div class="searching-local">Calendar is unavailable right now.</div>'); });
}
function renderProactiveEvents(events) {
  const glance = document.querySelector('#agenda-glance');
  if (!glance) return;
  const title = document.querySelector('#home-title');
  if (!events.length) {
    title.textContent = 'You’re clear for now';
    document.querySelector('#agenda-label').textContent = 'ALL CLEAR';
    setHtml(glance, '<div class="clear-day"><span class="icon calendar">' + icon('calendar-check') + '</span><span><b>No upcoming events in the next two weeks.</b><small>Use the command bar when you’re ready to plan something.</small></span></div>');
  } else {
    const next = events[0];
    title.textContent = next.title || 'Your next event';
    document.querySelector('#agenda-label').textContent = 'UP NEXT';
    setHtml(glance, events.map((event, index) => {
      const start = new Date(event.start);
      const duration = Math.round((new Date(event.end) - start) / 60000);
      const allDay = duration >= 23 * 60 && start.getHours() === 0 && start.getMinutes() === 0;
      const when = allDay ? 'All day' : start.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
      const detail = allDay ? event.calendar : `${event.calendar} · ${duration} min`;
      return `<button class="glance-event ${index === 0 ? 'next' : ''}" data-event="${encodeURIComponent(JSON.stringify(event))}"><span class="glance-time">${escapeHtml(start.toLocaleDateString([], { weekday:'short' }))}<b>${escapeHtml(when)}</b></span><span class="glance-copy"><b>${escapeHtml(event.title || 'Untitled event')}</b><small>${escapeHtml(detail)}</small></span><i data-lucide="chevron-right"></i></button>`;
    }).join(''));
    glance.querySelectorAll('.glance-event').forEach(button => button.onclick = () => showEventDraft(JSON.parse(decodeURIComponent(button.dataset.event))));
  }
  applyHomeLayout();
  refreshIcons();
}
function renderProactiveBriefing() {
  const target = document.querySelector('#proactive-briefing');
  const mailTarget = document.querySelector('#proactive-mail');
  if (!target) return;
  const events = proactiveContext.events || [];
  const mail = proactiveContext.mail || [];
  const provider = proactiveContext.provider || '';
  const next = events[0];
  if (!mail.length && !next) { setHtml(target, ''); if (mailTarget) setHtml(mailTarget, ''); return; }
  const nextDetail = next ? `${next.title || 'An event'} · ${new Date(next.start).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}` : '';
  const summaryTitle = mail.length && next ? `${mail.length} recent email${mail.length === 1 ? '' : 's'} · next up` : mail.length ? `${mail.length} recent email${mail.length === 1 ? '' : 's'}` : 'Your next moment';
  const summaryDetail = nextDetail || 'Nothing new needs your attention.';
  const mailCards = mail.slice(0, 3).map(thread => `<button class="briefing-mail" data-proactive-mail="${thread.id}" data-proactive-provider="${escapeHtml(thread.accountId || provider)}"><span class="icon gmail">${icon('mail')}</span><span><b>${escapeHtml(thread.subject || '(No subject)')}</b><small>${escapeHtml(thread.from || 'Unknown sender')} · ${escapeHtml(thread.accountEmail || '')}</small></span><time>${new Date(thread.timestamp).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}</time></button>`).join('');
  setHtml(target, `<span class="briefing-heading">HABIBI BRIEFING</span><div class="briefing-summary"><span class="briefing-icon">${icon('sparkles')}</span><span class="briefing-copy"><b>${escapeHtml(summaryTitle)}</b><small>${escapeHtml(summaryDetail)}</small></span></div>`);
  if (mailTarget) {
    setHtml(mailTarget, mailCards ? `<span class="briefing-heading">RECENT EMAIL</span><div class="proactive-mail-list">${mailCards}</div>` : '');
    mailTarget.querySelectorAll('[data-proactive-mail]').forEach(button => button.onclick = () => showMailThread(button.dataset.proactiveMail, button.dataset.proactiveProvider));
  }
  applyHomeLayout();
  refreshIcons();
}
function loadProactiveHome({ force = false } = {}) {
  const glance = document.querySelector('#agenda-glance');
  if (!glance) return;
  if (demoMode) {
    proactiveContext = { events:demoEvents, mail:demoMail, provider:'demo-mail' };
    document.querySelector('#home-date').textContent = 'TUESDAY, AUGUST 11';
    renderProactiveEvents(demoEvents);
    renderProactiveBriefing();
    return;
  }
  if (!force && proactiveLoadInFlight) return proactiveLoadInFlight;
  if (!force && proactiveLoadedAt && Date.now() - proactiveLoadedAt < proactiveCacheMs) {
    renderProactiveEvents(proactiveContext.events || []);
    renderProactiveBriefing();
    return Promise.resolve();
  }
  const now = new Date();
  proactiveContext = { events:[], mail:[], provider:'' };
  document.querySelector('#home-date').textContent = now.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' }).toUpperCase();
  setHtml(glance, '<div class="loading-state"><span class="spinner"></span> Checking your calendar…</div>');
  const briefing = document.querySelector('#proactive-briefing');
  if (briefing) setHtml(briefing, '<div class="loading-state"><span class="spinner"></span> Checking recent context…</div>');
  const calendarLoad = loadCalendarEvents().then(data => {
    if (!data.ok) throw new Error('Calendar unavailable');
    const events = data.events.slice(0, 4);
    proactiveContext.events = events;
    renderProactiveEvents(events);
    renderProactiveBriefing();
  }).catch(() => {
    document.querySelector('#home-title').textContent = 'Your day, privately';
    document.querySelector('#agenda-label').textContent = 'CALENDAR';
    setHtml(glance, '<button class="clear-day calendar-connect" id="connect-calendar"><span class="icon calendar">' + icon('calendar-clock') + '</span><span><b>Connect Calendar to see what’s next.</b><small>Allow Calendar access</small></span><i data-lucide="chevron-right"></i></button>');
    document.querySelector('#connect-calendar')?.addEventListener('click', requestCalendarAccess);
    applyHomeLayout();
    refreshIcons();
  });
  const mailLoad = fetch('/api/mail/status').then(response => response.json()).then(data => {
    const accounts = (data.accounts || []).filter(item => item.connected);
    if (!accounts.length) return;
    return fetch('/api/mail/recent?provider=all&hours=4').then(response => response.json()).then(recent => {
      if (!recent.ok) return;
      proactiveContext.mail = recent.threads || [];
      proactiveContext.provider = 'all';
      renderProactiveBriefing();
    });
  }).catch(() => {});
  proactiveLoadInFlight = Promise.allSettled([calendarLoad, mailLoad]).finally(() => {
    proactiveLoadedAt = Date.now();
    proactiveLoadInFlight = null;
    if (!proactiveContext.events.length && !proactiveContext.mail.length) renderProactiveBriefing();
  });
  return proactiveLoadInFlight;
}

function requestCalendarAccess() {
  const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
  if (!nativeBridge) { showUpcomingEvents(); return; }
  const button = document.querySelector('#connect-calendar');
  if (button) {
    button.disabled = true;
    button.querySelector('small').textContent = 'Requesting Calendar access…';
  }
  window.__habibiNativeCalendarAccess = result => {
    window.__habibiNativeCalendarAccess = null;
    if (!result?.ok) {
      if (button) { button.disabled = false; button.querySelector('small').textContent = result?.reason === 'writeOnly' ? 'Allow Full Calendar access' : 'Allow Calendar access'; }
      notify(result?.message || 'Calendar access was not granted.');
      return;
    }
    loadProactiveHome({ force:true });
  };
  nativeBridge.postMessage({ type:'calendarAccess' });
}

function loadCalendarEvents() {
  const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
  // Habibi is the native app; a plain browser has no EventKit access at all.
  if (!nativeBridge) return Promise.reject(new Error('Calendar needs the Habibi app.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.__habibiNativeCalendarEvents = null;
      reject(new Error('Calendar did not respond.'));
    }, 10_000);
    window.__habibiNativeCalendarEvents = payload => {
      clearTimeout(timer);
      window.__habibiNativeCalendarEvents = null;
      if (payload?.ok) return resolve(payload);
      // A write-only grant is the common case and is recoverable, so name it
      // rather than reporting a generic failure the user cannot act on.
      const reasons = {
        writeOnly:'Habibi can only add events. Allow full calendar access in System Settings → Privacy & Security → Calendars.',
        denied:'Calendar access is turned off. Allow it in System Settings → Privacy & Security → Calendars.',
        notDetermined:'Habibi has not been granted calendar access yet.',
      };
      reject(new Error(reasons[payload?.reason] || 'Calendar access is unavailable.'));
    };
    nativeBridge.postMessage({ type:'calendarEvents' });
  });
}
function mailThreadListMarkup(threads, connected, emptyCopy = 'No messages matched that search.') {
  return threads.length ? `<div class="result-list mail-thread-list">${threads.map((thread, index) => `<button class="result ${index === 0 ? 'selected' : ''}" data-mail-thread="${thread.id}" data-mail-provider="${thread.accountId}"><span class="icon gmail">${icon('mail')}</span><span class="result-copy"><span class="result-title">${escapeHtml(thread.subject)}</span><span class="result-meta">${escapeHtml(thread.from || 'Unknown sender')} · ${escapeHtml(thread.label || connected.find(account => account.id === thread.accountId)?.label || 'Mail')} · ${escapeHtml(thread.accountEmail || '')}</span></span><span class="chat-end"><time>${thread.timestamp ? new Date(thread.timestamp).toLocaleDateString([], { month:'short', day:'numeric' }) : ''}</time>${thread.unread ? `<span class="unread-mail" title="Unread email" aria-label="Unread email">${icon('mail')}</span>` : ''}</span></button>`).join('')}</div>` : `<div class="clear-day"><span class="icon gmail">${icon('inbox')}</span><span><b>${escapeHtml(emptyCopy)}</b><small>Try a sender, subject, phrase, or a natural-language request.</small></span></div>`;
}
function bindMailThreads(target) {
  target.querySelectorAll('[data-mail-thread]').forEach(button => button.onclick = () => showMailThread(button.dataset.mailThread, button.dataset.mailProvider));
  refreshIcons();
}
function renderMailInbox(threads, connected) {
  if (!mailInboxState?.target?.isConnected) return;
  setHtml(mailInboxState.target, mailThreadListMarkup(threads, connected, 'Your inbox is empty.'));
  bindMailThreads(mailInboxState.target);
}
function searchMailInbox(query) {
  const state = mailInboxState;
  if (!state?.target?.isConnected) return;
  clearTimeout(mailSearchTimer);
  const trimmed = query.trim();
  if (!trimmed) {
    document.querySelector('#mail-status-copy').textContent = state.status;
    count.textContent = `${state.threads.length} messages`;
    renderMailInbox(state.threads, state.connected);
    return;
  }
  const sequence = ++mailSearchSequence;
  mailSearchTimer = setTimeout(async () => {
    if (!mailInboxState?.target?.isConnected || sequence !== mailSearchSequence) return;
    setHtml(state.target, '<div class="loading-state"><span class="spinner"></span> Searching your connected inboxes…</div>');
    count.textContent = 'Searching mail…';
    try {
      const response = await fetch(`/api/mail/search?q=${encodeURIComponent(trimmed)}&provider=all`);
      const data = await response.json();
      if (sequence !== mailSearchSequence || !mailInboxState?.target?.isConnected) return;
      if (!data.ok) throw new Error(data.error || 'Could not search mail.');
      const plan = data.plan || {};
      const planner = plan.source === 'local-model' ? 'local model' : 'local matching';
      document.querySelector('#mail-status-copy').textContent = `Search results · ${planner}`;
      count.textContent = `${(data.threads || []).length} matching messages`;
      setHtml(state.target, mailThreadListMarkup(data.threads || [], state.connected));
      bindMailThreads(state.target);
    } catch (error) {
      if (sequence !== mailSearchSequence || !mailInboxState?.target?.isConnected) return;
      setHtml(state.target, `<div class="local-files-empty">${escapeHtml(error.message || 'Could not search mail.')}</div>`);
    }
  }, 260);
}
function showMailClient({ compose = false } = {}) {
  launcherMode = 'mail';
  clearTimeout(mailSearchTimer); mailSearchSequence += 1; mailInboxState = null;
  input.value = ''; input.placeholder = 'Search mail by sender, subject, or request…';
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = 'Mail · connect an account';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-mail">${icon('arrow-left')} Habibi</button><span class="verified">● private mail client</span></div><section class="chat-client mail-client"><div class="chat-title"><span class="icon gmail">${icon('mail')}</span><span><b>Mail</b><small id="mail-status-copy">Checking connected accounts…</small></span><button class="history-button" id="manage-mail">Manage accounts</button></div><div class="messages mail-empty" id="mail-accounts"><div class="loading-state"><span class="spinner"></span> Checking mail connections…</div></div><div class="chat-composer"><textarea id="mail-quick-reply" rows="2" placeholder="Reply once an email thread is open…" disabled></textarea><div><span>${compose ? 'Connect an account to draft an email' : 'Select a thread to reply'}</span><button class="primary" disabled>Send <kbd>⌘ ↵</kbd></button></div></div></section>`);
  document.querySelector('#back-mail').onclick = showDefault;
  document.querySelector('#manage-mail').onclick = showMailSettings;
  fetch('/api/mail/status').then(response => response.json()).then(data => {
    const target = document.querySelector('#mail-accounts'); const copy = document.querySelector('#mail-status-copy');
    if (!target || !data.ok) throw new Error('Mail unavailable');
    const providers = data.providers || [];
    const connected = (data.accounts || []).filter(account => account.connected);
    if (!connected.length) {
      setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-mail">${icon('arrow-left')} Habibi</button><span class="verified">● private mail</span></div><section class="mail-onboarding"><div class="openwa-intro"><span class="icon gmail">${icon('mail')}</span><span><h2>Connect your mail</h2><p>Read threads and reply from Habibi. Your inbox stays with the provider; sending always asks for approval.</p></span></div><div class="provider-options mail-provider-options">${providers.map(provider => `<button class="provider-option" data-mail-provider="${provider.id}"><span><b>${icon('mail')} ${provider.label}</b><small>${provider.configured ? 'Continue with your configured OAuth app' : 'Set up your OAuth app to connect'}</small></span><em>${provider.configured ? 'CONNECT' : 'SET UP'}</em><i>${icon('chevron-right')}</i></button>`).join('')}</div></section>`);
      document.querySelector('#back-mail').onclick = showDefault;
      resultsView.querySelectorAll('[data-mail-provider]').forEach(button => button.onclick = () => showMailProviderSetup(button.dataset.mailProvider));
      refreshIcons();
      return;
    }
    const status = connected.map(account => `${account.label} · ${account.email}`).join(' + ');
    copy.textContent = status;
    document.querySelector('.mail-client .chat-composer')?.remove();
    setHtml(target, '<div class="loading-state"><span class="spinner"></span> Loading your inbox…</div>');
    Promise.all(connected.map(account => fetch(`/api/mail/threads?provider=${encodeURIComponent(account.id)}`).then(response => response.json()))).then(inboxes => {
      const threads = inboxes.flatMap(inbox => inbox.ok ? inbox.threads : []).sort((a, b) => b.timestamp - a.timestamp);
      mailInboxState = { target, connected, threads, status };
      count.textContent = `${threads.length} messages`;
      renderMailInbox(threads, connected);
    }).catch(error => { setHtml(target, `<div class="local-files-empty">${escapeHtml(error.message || 'Could not load your inbox.')}</div>`); });
  }).catch(() => { const target = document.querySelector('#mail-accounts'); if (target) target.textContent = 'Mail connection status is unavailable.'; });
  refreshIcons();
}
function showMailThread(threadId, provider) {
  launcherMode = 'mail-thread';
  mailInboxState = null;
  // This route is also opened directly from the Home briefing. Make the
  // transition explicit instead of relying on the Mail inbox having already
  // revealed the results surface.
  defaultView.classList.add('hidden');
  resultsView.classList.remove('hidden');
  input.value = '';
  input.placeholder = 'Search mail by sender, subject, or request…';
  const providerLabel = provider === 'zoho' ? 'Zoho Mail' : provider === 'gmail' ? 'Gmail' : 'Mail';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-mail-thread">${icon('arrow-left')} Mail</button><span class="verified">● ${escapeHtml(provider || 'mail')}</span></div><section class="chat-client mail-thread-client"><div class="chat-title"><span class="icon gmail">${icon('mail')}</span><span><b>Loading email…</b><small>Reading from your connected account</small></span></div><div class="messages"><div class="loading-state"><span class="spinner"></span> Loading message…</div></div><div class="chat-composer"><textarea rows="2" placeholder="Reply support is coming next…" disabled></textarea><div><span>Sending always requires approval</span><span class="composer-actions"><button class="secondary" id="open-mail-provider">Open in ${providerLabel} <kbd>⌘ ↵</kbd></button><button class="primary" disabled>Reply</button></span></div></div></section>`);
  document.querySelector('#back-mail-thread').onclick = showMailClient;
  fetch(`/api/mail/message?provider=${encodeURIComponent(provider)}&uid=${encodeURIComponent(threadId)}`).then(response => response.json()).then(data => {
    if (!data.ok) throw new Error(data.error);
    const message = data.message; const box = document.querySelector('.mail-thread-client .messages');
    document.querySelector('.mail-thread-client .chat-title b').textContent = message.subject;
    document.querySelector('.mail-thread-client .chat-title small').textContent = `${message.from} · ${message.accountEmail || ''}`;
    const actualProvider = message.provider || provider;
    const actualProviderLabel = actualProvider === 'zoho' ? 'Zoho Mail' : actualProvider === 'gmail' ? 'Gmail' : 'Mail';
    setHtml(document.querySelector('#open-mail-provider'), `Open in ${actualProviderLabel} <kbd>⌘ ↵</kbd>`);
    const attachmentMarkup = message.attachments?.length ? `<div class="mail-message-attachments">${message.attachments.map(attachment => `<span>${icon('paperclip')} ${escapeHtml(attachment.filename)} · ${Math.max(1, Math.round(attachment.size / 1024))} KB</span>`).join('')}</div>` : '';
    const formatMailBody = value => escapeHtml(value).split(/\n{2,}/).map(part => `<p>${part.replace(/\n/g, '<br>')}</p>`).join('');
    const senderName = value => String(value || 'Unknown sender').replace(/\s*<[^>]+>\s*$/, '').replace(/^"|"$/g, '');
    const messageTime = (part, index) => {
      const value = part.timestamp || Date.parse(part.sent || '') || (index === 0 ? message.timestamp : 0);
      return value ? new Date(value).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '';
    };
    const forwardMarker = part => part.forwardedFrom ? `<div class="forwarded-message"><span class="forwarded-icon">${icon('forward')}</span><span><b>Forwarded message</b><small>From ${escapeHtml(senderName(part.forwardedFrom))}${part.forwardedFrom.match(/<([^>]+)>/)?.[1] ? ` · ${escapeHtml(part.forwardedFrom.match(/<([^>]+)>/)?.[1])}` : ''}</small>${part.forwardedTo ? `<small>Forwarded to ${escapeHtml(part.forwardedTo)}</small>` : ''}</span></div>` : '';
    setHtml(box, (message.messages || []).map((part, index) => `<article class="message ${part.direction === 'outgoing' ? 'outgoing' : 'incoming'} mail-message"><header class="mail-message-header"><span class="mail-sender">${escapeHtml(senderName(part.from))}</span>${part.from && senderName(part.from) !== part.from ? `<span class="mail-address">${escapeHtml(part.from.match(/<([^>]+)>/)?.[1] || '')}</span>` : ''}</header><div class="mail-body ${part.html ? 'mail-html' : ''}">${part.html || formatMailBody(part.body)}</div>${forwardMarker(part)}${index === 0 ? attachmentMarkup : ''}<time>${escapeHtml(messageTime(part, index))}</time></article>`).join('') || '<div class="local-files-empty">No readable message content.</div>');
    const openProvider = async () => {
      const button = document.querySelector('#open-mail-provider');
      if (button?.disabled) return;
      button.disabled = true;
      const result = await fetch('/api/mail/open', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ provider:message.accountId || provider, subject:message.subject, messageId:message.messageId }) }).then(response => response.json()).catch(() => ({ ok:false }));
      button.disabled = false;
      if (!result.ok) return notify('Could not open your mail provider.');
      notify(actualProvider === 'zoho' ? 'Opened Zoho Mail' : 'Opened this email in Gmail');
    };
    document.querySelector('#open-mail-provider').onclick = openProvider;
    document.querySelector('#open-mail-provider').dataset.mailOpen = 'true';
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }).catch(error => { const box = document.querySelector('.mail-thread-client .messages'); if (box) setHtml(box, `<div class="local-files-empty">${escapeHtml(error.message || 'Could not load this message.')}</div>`); });
  refreshIcons();
}
function showMailSettings() {
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-mail-settings">${icon('arrow-left')} Mail</button><span class="verified">● local settings</span></div><section class="provider-setup"><div class="chat-title"><span class="icon gmail">${icon('settings')}</span><span><b>Mail accounts</b><small>Connections and credentials stay on this Mac.</small></span></div><div id="mail-settings-list" class="provider-options"><div class="loading-state"><span class="spinner"></span> Loading accounts…</div></div></section>`);
  document.querySelector('#back-mail-settings').onclick = showMailClient;
  fetch('/api/mail/status').then(response => response.json()).then(data => {
    const list = document.querySelector('#mail-settings-list');
    const accounts = data.accounts || [];
    setHtml(list, `${accounts.map(account => `<div class="provider-option"><span><b>${escapeHtml(account.label)} · ${escapeHtml(account.email)}</b><small>Connected via ${escapeHtml(account.transport || 'IMAP')}</small></span><span class="mail-settings-actions"><button class="secondary" data-reconnect="${account.provider}">Add another</button><button class="secondary" data-remove-mail="${escapeHtml(account.id)}">Remove</button></span></div>`).join('')}<div class="provider-option"><span><b>Add mail account</b><small>Connect another Gmail or Zoho Mail inbox.</small></span><span class="mail-settings-actions">${(data.providers || []).map(provider => `<button class="secondary" data-reconnect="${provider.id}">${provider.label}</button>`).join('')}</span></div>`);
    list.querySelectorAll('[data-reconnect]').forEach(button => button.onclick = () => showMailProviderSetup(button.dataset.reconnect));
    list.querySelectorAll('[data-remove-mail]').forEach(button => button.onclick = async () => { button.disabled = true; const result = await fetch('/api/mail/remove', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ provider:button.dataset.removeMail }) }).then(response => response.json()); if (!result.ok) return notify(result.error || 'Could not remove account'); notify('Mail account removed'); showMailSettings(); });
  }).catch(() => { const list = document.querySelector('#mail-settings-list'); if (list) list.textContent = 'Mail settings are unavailable.'; });
  refreshIcons();
}
function showMailProviderSetup(provider) {
  const label = provider === 'zoho' ? 'Zoho Mail' : 'Gmail';
  const host = provider === 'gmail' ? 'imap.gmail.com' : 'imappro.zoho.com';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-mail-setup">${icon('arrow-left')} Mail</button><span class="verified">● IMAP setup</span></div><section class="provider-setup"><div class="chat-title"><span class="icon gmail">${icon('mail')}</span><span><b>Connect ${label}</b><small>Use a provider app password. It stays in macOS Keychain.</small></span></div><div class="provider-detail"><div class="provider-fields"><label>Email address<input id="mail-email" type="email" autocomplete="email" /></label><label>App password<input id="mail-app-password" type="password" autocomplete="off" /></label><label>IMAP server<input id="mail-imap-host" value="${host}" autocomplete="off" /></label></div><div class="provider-actions"><span>IMAP uses SSL on port 993.</span><button class="primary" id="connect-mail-provider">Connect <kbd>↵</kbd></button></div></div></section>`);
  document.querySelector('#back-mail-setup').onclick = showMailClient;
  document.querySelector('#connect-mail-provider').onclick = async () => {
    const response = await fetch('/api/mail/imap', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ provider, email:document.querySelector('#mail-email').value, password:document.querySelector('#mail-app-password').value, host:document.querySelector('#mail-imap-host').value }) });
    const configured = await response.json();
    if (!configured.ok) return notify(configured.error || 'Could not save mail configuration');
    notify(`${label} connected`); showMailClient();
  };
  refreshIcons();
}
function showEmailComposer(subject, attachment) {
  // Drop-to-compose and the ⌘N shortcut can reach this before the Mail client
  // has ever loaded account status, so fetch it rather than assume it's cached.
  if (!mailInboxState?.connected) {
    fetch('/api/mail/status').then(response => response.json()).then(data => {
      mailInboxState = { connected:(data.accounts || []).filter(account => account.connected) };
      renderEmailComposer(subject, attachment);
    }).catch(() => { mailInboxState = { connected:[] }; renderEmailComposer(subject, attachment); });
    return;
  }
  renderEmailComposer(subject, attachment);
}
function renderEmailComposer(subject, attachment) {
  const connected = mailInboxState?.connected || [];
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = connected.length ? `${connected[0].label} · draft` : 'Mail · draft';
  const accountOptions = connected.map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.label)} · ${escapeHtml(account.email)}</option>`).join('');
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-email-compose">${icon('arrow-left')} Mail</button><span class="verified">● draft stays local</span></div>
    <section class="mail-compose">${connected.length > 1 ? `<div class="mail-line"><span>From</span><select id="mail-from">${accountOptions}</select></div>` : ''}<div class="mail-line"><span>To</span><input id="mail-to" type="email" placeholder="Recipient" aria-label="Email recipient" /></div><div class="mail-line"><span>Subject</span><input id="mail-subject" value="${escapeHtml(subject === 'Gmail' ? '' : subject && subject !== 'New email' ? `Re: ${subject}` : '')}" aria-label="Email subject" /></div><textarea id="mail-body" class="mail-body" placeholder="Write a message…"></textarea><div id="attachment-zone" class="attachment-zone"><span class="icon files">${icon('paperclip')}</span><span><b>Drop a local file here</b><small>It will be attached to this draft</small></span></div><div class="attachment-list"></div><div class="mail-actions"><span>${connected.length ? 'Only sends after approval' : 'Connect a mail account first'}</span><button class="primary" id="send-email"${connected.length ? '' : ' disabled'}>Send email <kbd>⌘ ↵</kbd></button></div></section>`);
  document.querySelector('#back-email-compose').onclick = showMailClient;
  if (attachment) addAttachment(attachment);
  const zone = document.querySelector('#attachment-zone');
  zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', event => { event.preventDefault(); zone.classList.remove('drag-over'); const path = event.dataTransfer.getData('application/x-habibi-file'); if (path) addAttachment({ path, name: event.dataTransfer.getData('application/x-habibi-name') }); });
  const sendButton = document.querySelector('#send-email');
  const send = async () => {
    if (sendButton.disabled) return;
    const provider = connected.length > 1 ? document.querySelector('#mail-from').value : connected[0]?.id;
    const to = document.querySelector('#mail-to').value.trim();
    const subjectValue = document.querySelector('#mail-subject').value.trim();
    const body = document.querySelector('#mail-body').value.trim();
    if (!provider) return notify('Connect a mail account first');
    if (!to) return notify('Enter a recipient');
    if (!body) return notify('Write a message first');
    sendButton.disabled = true; const originalLabel = sendButton.innerHTML; setHtml(sendButton, '<span class="mini-spinner"></span> Sending');
    try {
      const approvalToken = await requestApproval('mail.send', { provider, to, subject:subjectValue, body });
      const result = await fetch('/api/mail/send', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ provider, to, subject:subjectValue, body, approvalToken }) }).then(response => response.json());
      if (!result.ok) throw new Error(result.error || 'Could not send this email.');
      notify('Email sent'); showMailClient();
    } catch (error) {
      sendButton.disabled = false; setHtml(sendButton, originalLabel);
      notify(error.message || 'Could not send this email.');
    }
  };
  sendButton.onclick = send;
  resultsView.querySelector('.mail-compose').addEventListener('keydown', event => { if (event.metaKey && event.key === 'Enter') { event.preventDefault(); send(); } });
  refreshIcons();
}
function addAttachment(file) {
  const list = document.querySelector('.attachment-list');
  if (!list || list.dataset.path === file.path) return;
  list.dataset.path = file.path;
  const isPdf = /\.pdf$/i.test(file.name);
  setHtml(list, `<div class="attachment"><span class="icon ${isPdf ? 'pdf' : 'files'}">${icon(isPdf ? 'file-text' : 'file')}</span><span><b>${escapeHtml(file.name)}</b><small>Local file · attached to draft</small></span><button aria-label="Remove attachment">${icon('x')}</button></div>`);
  list.querySelector('button').onclick = () => { list.innerHTML=''; list.dataset.path=''; };
  refreshIcons();
}
function previewFile(path, name) {
  fetch('/api/quick-look', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ path }) })
    .then(response => response.json())
    .then(result => notify(result.ok ? (result.state === 'opened' ? `Quick Look: ${name}` : 'Quick Look closed') : 'Could not open Quick Look'))
    .catch(() => notify('Could not open Quick Look'));
}
function showChatClient() {
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent='WhatsApp · local service';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-whatsapp-client">${icon('arrow-left')} Habibi</button><span class="verified">● preparing WhatsApp</span></div><div class="loading-state"><span class="spinner"></span> <span id="whatsapp-component-copy">Checking the private WhatsApp component…</span></div>`);
  document.querySelector('#back-whatsapp-client').onclick = showDefault;
  ensureNativeWhatsAppComponent().then(() => fetch('/api/openwa/status')).then(response => response.json()).then(status => {
    if (status.ok && status.session?.status === 'ready') return showWhatsAppChats();
    if (status.ok && !status.session) {
      const setStartingCopy = text => { const line = document.querySelector('#openwa-starting-copy'); if (line) line.textContent = text; };
      setHtml(resultsView, `<div class="result-header conversation-mode"><b>WhatsApp</b><span class="verified">● local setup</span></div><div class="loading-state"><span class="spinner"></span> <span id="openwa-starting-copy">Starting your private WhatsApp session…</span></div>`);
      // /api/openwa/connect launches a real Chromium process on first run —
      // 10-20+ seconds is normal, not stuck, but the plain spinner gave no
      // sense of that; without this a user watching the same static line for
      // that long has no way to tell "still working" from "hung", which is
      // exactly what got reported here. Swap the copy at two checkpoints
      // rather than a live counter: cheap to implement, and still tells the
      // user this is expected, not broken.
      const slow = setTimeout(() => setStartingCopy('Still starting — the first launch can take a bit longer…'), 6_000);
      const verySlow = setTimeout(() => setStartingCopy('Still working on it. This is unusually long, but WhatsApp setup is worth the wait — hang tight.'), 20_000);
      return fetch('/api/openwa/connect', { method:'POST' }).then(response => response.json()).then(status => {
        clearTimeout(slow); clearTimeout(verySlow);
        showOpenWASetup(status);
      });
    }
    showOpenWASetup(status);
  }).catch(error => {
    setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-whatsapp-component">${icon('arrow-left')} Habibi</button><span class="verified">● component unavailable</span></div><div class="clear-day"><span class="icon whatsapp">${icon('message-circle-more')}</span><span><b>WhatsApp could not start.</b><small>${escapeHtml(error?.message || 'The local WhatsApp component is unavailable.')}</small></span><button class="secondary" id="retry-whatsapp-component">Try again</button></div>`);
    document.querySelector('#back-whatsapp-component').onclick = showDefault;
    document.querySelector('#retry-whatsapp-component').onclick = showChatClient;
    refreshIcons();
  });
}
function ensureNativeWhatsAppComponent() {
  const bridge = window.webkit?.messageHandlers?.habibiNative;
  if (!bridge) return Promise.resolve();
  if (whatsappComponentPromise) return whatsappComponentPromise;
  whatsappComponentPromise = new Promise((resolve, reject) => {
    const copy = text => { const line = document.querySelector('#whatsapp-component-copy'); if (line) line.textContent = text; };
    const labels = {
      downloading:'Downloading WhatsApp support securely…',
      verifying:'Asking macOS to verify the signed component…',
      starting:'Starting the private WhatsApp service…'
    };
    const timeout = setTimeout(() => {
      window.__habibiWhatsAppComponent = undefined;
      whatsappComponentPromise = null;
      reject(new Error('The WhatsApp component took too long to start.'));
    }, 600_000);
    window.__habibiWhatsAppComponent = status => {
      if (status?.state === 'downloading' && Number.isInteger(status.progress)) {
        copy(`Downloading WhatsApp support securely… ${status.progress}%`);
      } else if (labels[status?.state]) copy(labels[status.state]);
      if (status?.ok === true) {
        clearTimeout(timeout);
        window.__habibiWhatsAppComponent = undefined;
        whatsappComponentPromise = null;
        resolve();
      } else if (status?.ok === false) {
        clearTimeout(timeout);
        window.__habibiWhatsAppComponent = undefined;
        whatsappComponentPromise = null;
        reject(new Error(status.error || 'The WhatsApp component could not be installed.'));
      }
    };
    bridge.postMessage({ type:'whatsappComponent' });
  });
  return whatsappComponentPromise;
}
function showOpenWASetup(status) {
  if (document.querySelector('#openwa-dynamic')) return updateOpenWASetup(status);
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-whatsapp-setup">${icon('arrow-left')} Habibi</button><span id="openwa-status" class="verified">● getting started</span></div><section class="openwa-setup"><div class="openwa-intro"><span class="icon whatsapp">${icon('message-circle-more')}</span><span><h2>Set up WhatsApp</h2><p id="openwa-copy">Preparing your local WhatsApp session…</p></span></div><ol class="setup-steps"><li id="openwa-step-session"><span>1</span><b>Start local session</b><small>Starting</small></li><li id="openwa-step-phone"><span>2</span><b>Link your phone</b><small>WhatsApp → Linked devices</small></li><li id="openwa-step-chat"><span>3</span><b>Start messaging</b><small>Search chats in Habibi</small></li></ol><div id="openwa-dynamic"></div></section>`);
  document.querySelector('#back-whatsapp-setup').onclick = showDefault;
  openwaStateKey = null;
  updateOpenWASetup(status);
}
function updateOpenWASetup(status) {
  const ready = status.session?.status === 'ready';
  // The phone can finish linking after this view has rendered. Do not leave the
  // user on a completed setup screen (or require a refresh): enter the chat list
  // as soon as OpenWA confirms readiness.
  if (ready) return showWhatsAppChats();
  const linking = status.session?.status === 'authenticating';
  const connecting = linking && !status.qrCode;
  // OpenWA can retain the last phone metadata after WhatsApp has rejected the
  // pairing. A qr_ready session with a previous connection is a retry state, not a
  // successful connection.
  const linkWasNotKept = status.session?.status === 'qr_ready' && Boolean(status.session?.connectedAt);
  const localStarted = Boolean(status.session && ['qr_ready', 'authenticating', 'ready'].includes(status.session.status));
  const copy = ready ? 'Your chats are ready to use in Habibi.' : linkWasNotKept ? 'WhatsApp did not keep the previous device link. Scan this fresh code to try again.' : status.qrCode ? 'On your phone: WhatsApp → Settings → Linked devices → Link a device.' : connecting ? 'Connecting your phone now — keep WhatsApp open for a moment.' : 'Habibi is preparing your private WhatsApp connection.';
  const sessionRunning = Boolean(status.session);
  document.querySelector('#openwa-status').textContent = ready ? '● connected' : linkWasNotKept ? '● link needs retry' : connecting ? '● connecting' : '● getting started';
  document.querySelector('#openwa-copy').textContent = status.ok ? copy : 'OpenWA is not running locally.';
  const setStep = (id, state, label) => { const step = document.querySelector(id); step.className = state; step.querySelector('small').textContent = label; };
  setStep('#openwa-step-session', localStarted ? 'done' : sessionRunning ? 'active' : '', localStarted ? 'Ready' : sessionRunning ? 'Starting' : 'Starting');
  setStep('#openwa-step-phone', ready ? 'done' : status.qrCode || connecting ? 'active' : '', ready ? 'Linked' : linkWasNotKept ? 'Link was not kept' : status.qrCode ? 'Ready to scan' : connecting ? 'Connecting…' : 'WhatsApp → Linked devices');
  setStep('#openwa-step-chat', ready ? 'done' : '', ready ? 'Ready' : 'Search chats in Habibi');
  const dynamic = document.querySelector('#openwa-dynamic');
  const stateKey = `${status.session?.status || 'none'}:${status.session?.connectedAt || ''}:${status.qrCode || ''}`;
  if (stateKey !== openwaStateKey) {
    openwaStateKey = stateKey;
    setHtml(dynamic, `${connecting ? '<div class="connection-pending"><span class="mini-spinner"></span><span><b>Connecting your phone…</b><small>This normally takes a few seconds.</small></span></div>' : ''}${linkWasNotKept ? '<div class="link-warning">The previous link was not accepted. Use the currently displayed QR code.</div>' : ''}${status.qrCode ? `<img class="openwa-qr" src="${safeImageSrc(status.qrCode)}" alt="Scan with WhatsApp to link this local session" />` : ''}<div class="openwa-actions">${ready ? '<button class="primary" id="show-chats">Open chats</button>' : '<button class="secondary" id="restart-openwa">Refresh pairing</button>'}</div>`);
    document.querySelector('#restart-openwa')?.addEventListener('click', () => {
      const button = document.querySelector('#restart-openwa');
      button.disabled = true;
      button.textContent = 'Refreshing…';
      // A QR-ready session is already running. Asking OpenWA to start it again can
      // take a while; read the current QR directly and force just this small region
      // to redraw, even if the QR itself has not rotated yet.
      fetch('/api/openwa/status')
        .then(response => response.json())
        .then(status => status.session ? status : fetch('/api/openwa/connect', { method:'POST' }).then(response => response.json()))
        .then(status => { openwaStateKey = null; updateOpenWASetup(status); })
        .catch(() => { openwaStateKey = null; updateOpenWASetup({ ok:false }); });
    });
    document.querySelector('#show-chats')?.addEventListener('click', showWhatsAppChats);
  }
  refreshIcons();
  if (status.ok && status.session && !ready) setTimeout(() => {
    if (!resultsView.classList.contains('hidden') && document.querySelector('#openwa-dynamic')) fetch('/api/openwa/status').then(response => response.json()).then(updateOpenWASetup).catch(() => {});
  }, 1500);
}
function showSkills() {
  launcherMode = 'skills'; defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent='Loading skills…';
  const skills = [['⌁','files','Files','Native index · Metadata read'],['□','calendar','Calendar','EventKit · Read & write'],['M','gmail','Mail','Gmail + Zoho IMAP · Local accounts'],['◔','whatsapp','WhatsApp','OpenWA · Localhost only'],['◉','files','Browser','Extension · Tabs & history'],['✣','agents','Agent Dock','Local Codex & Claude processes']];
  const render = imported => {
    const groups = { codex:[], claude:[], mcp:[] };
    imported.forEach(skill => groups[skill.source]?.push(skill));
    const importedMarkup = [['codex','Codex skills'],['claude','Claude Code skills'],['mcp','MCP servers']].map(([source, label]) => groups[source].length ? `<section class="imported-skill-group"><span class="briefing-heading">${label}</span><div class="imported-skill-list">${groups[source].map(skill => `<button class="imported-skill" data-imported-skill="${escapeHtml(skill.id)}"><span class="icon agents">${icon(source === 'mcp' ? 'plug-zap' : source === 'codex' ? 'braces' : 'sparkles')}</span><span><b>${escapeHtml(skill.name)}</b><small>${escapeHtml(skill.description)}</small></span><em>${skill.kind === 'mcp-server' ? 'MCP' : 'IMPORTED'}</em><i>${icon('chevron-right')}</i></button>`).join('')}</div></section>` : '').join('');
    count.textContent = `${skills.length + imported.length} skills available`;
    resultsView.innerHTML=`<div class="result-header conversation-mode"><button class="back-button" id="back-skills">${icon('arrow-left')} Habibi</button><span class="verified">● local capabilities</span></div><div class="skill-grid">${skills.map(s=>`<article class="skill"><span class="icon ${s[1]}">${s[0]}</span><h3>${s[2]}</h3><p>${s[3]}</p><div class="skill-footer"><span class="permission">● enabled</span><span>Built in</span></div></article>`).join('')}</div><div class="imported-skills"><div class="imported-skills-heading"><span class="briefing-heading">IMPORTED AGENT CAPABILITIES</span><small>Read from local Codex, Claude, and MCP configuration. Nothing runs until you approve it.</small></div>${importedMarkup || '<div class="clear-day imported-empty"><span class="icon agents">' + icon('scan-search') + '</span><span><b>No imported skills found yet.</b><small>Add a Codex SKILL.md, Claude command, or local MCP configuration and reopen Skills.</small></span></div>'}</div>`;
    document.querySelector('#back-skills').onclick = showDefault;
    resultsView.querySelectorAll('[data-imported-skill]').forEach(button => button.onclick = () => showImportedSkill(button.dataset.importedSkill));
    refreshIcons();
  };
  fetch('/api/agent-skills').then(response => response.json()).then(data => render(data.ok ? data.skills || [] : [])).catch(() => render([]));
}
function showImportedSkill(id) {
  launcherMode = 'imported-skill'; count.textContent = 'Inspecting imported skill…';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-imported-skills">${icon('arrow-left')} Skills</button><span class="verified">● review before run</span></div><div class="loading-state"><span class="spinner"></span> Inspecting this local capability…</div>`);
  document.querySelector('#back-imported-skills').onclick = showSkills;
  fetch('/api/agent-skills/preview', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ id }) }).then(response => response.json()).then(data => {
    if (!data.ok) throw new Error(data.error || 'Could not inspect this skill.');
    const skill = data.skill;
    const run = async ({ toolName, toolInput }) => {
      const approvalToken = await requestApproval('agent-skill.execute', { id, toolName:toolName ?? null, toolInput:toolInput ?? null });
      const button = document.querySelector('#run-imported-skill'); if (button) { button.disabled = true; setHtml(button, '<span class="mini-spinner"></span> Starting…'); }
      const result = await fetch('/api/agent-skills/execute', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ id, toolName, toolInput, approvalToken }) }).then(response => response.json());
      if (!result.ok) { if (button) { button.disabled=false; button.textContent='Try again'; } return notify(result.error || 'Could not run that skill.'); }
      if (result.result) { const output = document.querySelector('#imported-skill-output'); setHtml(output, `<pre>${escapeHtml(JSON.stringify(result.result, null, 2).slice(0, 12_000))}</pre>`); notify('MCP tool completed'); }
      else { notify(`${skill.source === 'codex' ? 'Codex' : 'Claude Code'} opened with your approved request`); showDefault(); }
    };
    if (skill.kind === 'mcp-server') {
      const tools = data.tools || [];
      setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-imported-skills">${icon('arrow-left')} Skills</button><span class="verified">● MCP · reviewed</span></div><section class="provider-setup imported-skill-review"><div class="chat-title"><span class="icon agents">${icon('plug-zap')}</span><span><b>${escapeHtml(skill.name)}</b><small>${escapeHtml(skill.description)}</small></span></div><p class="imported-note">${escapeHtml(data.action)}. Connecting only happens after you opened this review.</p><label>Tool<select id="imported-mcp-tool">${tools.map(tool => `<option value="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}${tool.readOnly ? ' · read' : ' · writes'}</option>`).join('')}</select></label><label>JSON input<textarea id="imported-mcp-input" rows="5" spellcheck="false">{}</textarea></label><div class="provider-actions"><span>Every call needs one explicit approval.</span><button class="primary" id="run-imported-skill">Run tool <kbd>↵</kbd></button></div><div id="imported-skill-output" class="imported-skill-output"></div></section>`);
      document.querySelector('#back-imported-skills').onclick = showSkills;
      document.querySelector('#run-imported-skill').onclick = () => { try { run({ toolName:document.querySelector('#imported-mcp-tool').value, toolInput:JSON.parse(document.querySelector('#imported-mcp-input').value) }); } catch (_) { notify('Tool input must be valid JSON.'); } };
    } else {
      setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-imported-skills">${icon('arrow-left')} Skills</button><span class="verified">● imported locally</span></div><section class="provider-setup imported-skill-review"><div class="chat-title"><span class="icon agents">${icon(skill.source === 'codex' ? 'braces' : 'sparkles')}</span><span><b>${escapeHtml(skill.name)}</b><small>${escapeHtml(skill.description)}</small></span></div><p class="imported-note">${escapeHtml(data.action)}. Habibi will launch the external agent only after your approval.</p><details class="instruction-preview"><summary>Review imported instruction</summary><pre>${escapeHtml(data.prompt || '')}</pre></details><label>Your request<textarea id="imported-skill-request" rows="3" placeholder="Optional context for this run…"></textarea></label><div class="provider-actions"><span>Recorded locally without prompt contents.</span><button class="primary" id="run-imported-skill">Open in ${skill.source === 'codex' ? 'Codex' : 'Claude'} <kbd>↵</kbd></button></div></section>`);
      document.querySelector('#back-imported-skills').onclick = showSkills;
      document.querySelector('#run-imported-skill').onclick = () => run({ toolInput:document.querySelector('#imported-skill-request').value });
    }
    refreshIcons();
  }).catch(error => { setHtml(resultsView, `<div class="local-files-empty">${escapeHtml(error.message || 'Could not inspect this skill.')}</div>`); });
}
input.addEventListener('input', event => {
  if (launcherMode === 'whatsapp') return filterWhatsAppChats(event.target.value.trim());
  if (launcherMode === 'mail') return searchMailInbox(event.target.value);
  if (launcherMode === 'running-apps') return filterRunningApplications(event.target.value);
  if (launcherMode === 'kubernetes') return;
  const query = event.target.value.trim();
  clearTimeout(commandSearchTimer);
  if (!query) return showDefault();
  markActivity();
  // Keep the current result set stable while a person is composing a query.
  // Local and app searching begin only once they pause briefly, preventing
  // rows from flickering or jumping beneath the cursor.
  commandSearchTimer = setTimeout(() => {
    if (launcherMode || input.value.trim() !== query) return;
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
  const isLargeText = shouldAttachPastedText(text);
  if (hasImage || hasFile || isLargeText) event.preventDefault();
  const files = await pastedImageFiles(clipboard);
  // The universal launcher is also an entry point to Habibi chat. Pasting a
  // rich item here must never disappear into a one-line search field.
  if (files.length || hasImage || hasFile || isLargeText) {
    if ((hasImage || hasFile) && !files.length && requestNativeClipboardImage()) return;
    if (hasImage && !files.length) return notify('Habibi could not read that image from the clipboard. Try copying the image itself, not its URL.');
    showEphemeralHabibiChat('', { files, text:files.length ? '' : text });
  }
});
input.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('.system-action-confirm') && !document.querySelector('#quick-preview')) { event.preventDefault(); dismissLauncher(); return; } if (launcherMode === 'kubernetes' && event.key === 'Enter') { event.preventDefault(); runKubernetesQuery(); return; } if (event.key === 'ArrowDown') { event.preventDefault(); resultsView.classList.contains('hidden') ? keyboard.navigateKeyboard(1) : keyboard.navigateResults(1, launcherMode !== 'whatsapp'); } if (event.key === 'ArrowUp') { event.preventDefault(); resultsView.classList.contains('hidden') ? keyboard.navigateKeyboard(-1) : keyboard.navigateResults(-1, launcherMode !== 'whatsapp'); } if (event.key === 'Enter' && !resultsView.classList.contains('hidden')) { event.preventDefault(); activateResult(document.querySelector('.result.selected') || document.querySelector('.result')); } });
const prepareNativeFileDrag = event => {
  const result = event.target.closest('.result[data-path], .agent-file[data-path]');
  const nativeHost = window.webkit?.messageHandlers?.habibiNative;
  if (!result || !nativeHost || event.button !== 0) return;
  const path = decodeURIComponent(result.dataset.path);
  nativeHost.postMessage({ type: 'prepareNativeFileDrag', path, title: result.dataset.title || path.split('/').pop() || 'file' });
};
// Capture at pointer-down, not at dragstart. Native AppKit must know the file
// before WebKit begins its own URL/text drag, otherwise Chrome receives only a
// filename/link rather than an uploadable file.
document.addEventListener('pointerdown', prepareNativeFileDrag, true);
document.addEventListener('mousedown', prepareNativeFileDrag);
document.addEventListener('dragstart', event => {
  const result = event.target.closest('.result[data-path], .agent-file[data-path]');
  if (!result) return;
  const path = decodeURIComponent(result.dataset.path);
  const localUrl = `${window.location.origin}/api/file?path=${encodeURIComponent(path)}`;
  const nativeFileUrl = `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`;
  const title = result.dataset.title || path.split('/').pop() || 'file';
  // In the native macOS host, hand this off to AppKit. WebKit only exposes a
  // URL drag here; external upload targets interpret that as text/link rather
  // than a file attachment. The native bridge publishes public.file-url.
  const nativeHost = window.webkit?.messageHandlers?.habibiNative;
  if (nativeHost) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData('application/x-habibi-file', path);
  event.dataTransfer.setData('application/x-habibi-name', title);
  // Provide both a native file URL (for upload drop zones) and Habibi's local
  // download endpoint (for browsers that intentionally reject file:// drops).
  event.dataTransfer.setData('text/plain', nativeFileUrl);
  event.dataTransfer.setData('text/uri-list', nativeFileUrl);
  event.dataTransfer.setData('DownloadURL', `application/octet-stream:${title}:${localUrl}`);
  event.dataTransfer.effectAllowed='copy';
  dropDock.classList.add('visible');
});
document.addEventListener('dragend', () => dropDock.classList.remove('visible'));
window.__habibiNativeDroppedFiles = async paths => {
  const safePaths = Array.isArray(paths) ? paths.filter(path => typeof path === 'string' && path.startsWith('/')).slice(0, 5) : [];
  if (!safePaths.length) return;
  try {
    const files = (await Promise.all(safePaths.map(async filePath => {
      const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
      if (!response.ok) return null;
      const blob = await response.blob();
      const name = filePath.split('/').pop() || 'Attachment';
      return new File([blob], name, { type:blob.type || 'application/octet-stream' });
    }))).filter(Boolean);
    if (!files.length) return notify('Habibi could not read that dropped file.');
    if (typeof window.__habibiAttachDroppedFiles === 'function') return window.__habibiAttachDroppedFiles(files);
    showEphemeralHabibiChat('', { files });
  } catch (_) { notify('Habibi could not read that dropped file.'); }
};
window.__habibiNativeFileDragStarted = () => dropDock.classList.add('visible');
window.__habibiNativeFileDragEnded = () => dropDock.classList.remove('visible');
window.__habibiNativeFileDragFailed = () => notify('Could not start a native file drag.');
dropDock.addEventListener('dragover', event => event.preventDefault());
dropDock.addEventListener('drop', event => { event.preventDefault(); const path = event.dataTransfer.getData('application/x-habibi-file'); if (path) showEmailComposer('New email', { path, name:event.dataTransfer.getData('application/x-habibi-name') }); dropDock.classList.remove('visible'); });
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
    const field = event.target;
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      event.preventDefault();
      field.select();
      return;
    }
  }
  const activeResult = document.activeElement.closest && document.activeElement.closest('.result');
  const activeButton = document.activeElement.matches && document.activeElement.matches('button');
  if (activeButton && !activeResult && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); keyboard.navigateKeyboard(event.key === 'ArrowDown' ? 1 : -1); return; }
  if (!activeResult) return;
  if (event.key === 'ArrowDown') { event.preventDefault(); keyboard.navigateResults(1); }
  if (event.key === 'ArrowUp') { event.preventDefault(); keyboard.navigateResults(-1); }
  if (event.code === 'Space' && activeResult.dataset.path) { event.preventDefault(); event.stopPropagation(); previewFile(decodeURIComponent(activeResult.dataset.path), activeResult.dataset.title); }
  if (event.key === 'Enter') { event.preventDefault(); activateResult(activeResult); }
});
document.addEventListener('click', event => { const action = event.target.closest('.quick-action'); if (action) { input.value=action.dataset.command; renderSearch(input.value); } const result = event.target.closest('.result[data-type]'); if (result) activateResult(result); const connect = event.target.closest('[data-connect]'); if (connect) notify(`${connect.dataset.connect} setup will open in the native app`); });
document.querySelector('#open-settings').onclick = showSettings;
document.querySelector('#open-preferences').onclick = showSettings;
window.__habibiOpenPreferences = () => showSettings();
document.querySelector('#open-agenda').onclick = showUpcomingEvents;
document.querySelectorAll('[data-sample]').forEach(button => button.onclick = () => { input.value = button.dataset.sample; markActivity(); renderSearch(input.value); });
window.addEventListener('keydown', event => {
  if (event.defaultPrevented) return;
  const preview = document.querySelector('#quick-preview');
  if (preview && (event.key === 'Escape' || event.code === 'Space')) { event.preventDefault(); preview.remove(); return; }
  if (event.key === 'Escape') { event.preventDefault(); dismissLauncher(); return; }
  if (event.metaKey && event.key === 'Enter' && document.querySelector('#open-mail-provider')) { event.preventDefault(); document.querySelector('#open-mail-provider').click(); return; }
  if (event.metaKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    const back = document.querySelector('.back-button');
    if (back) return back.click();
    if (document.querySelector('#back-chats')) return showWhatsAppChats();
    if (document.querySelector('#habibi-ephemeral-chat')) return showDefault();
    if (launcherMode === 'whatsapp') return showDefault();
  }
  if (event.metaKey && event.key.toLowerCase() === 'n' && launcherMode === 'mail') { event.preventDefault(); showEmailComposer('Mail'); return; }
  if (event.metaKey && event.key === 'ArrowDown' && !resultsView.classList.contains('hidden')) { event.preventDefault(); keyboard.jumpToLocalFiles(); return; }
  if (event.altKey && event.code === 'Space') { event.preventDefault(); input.focus(); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase()==='k') { event.preventDefault(); input.focus(); }
});
input.focus();
applyTheme();
applyColorMode();
refreshIcons();
if (demoMode) {
  localStorage.setItem(onboardingDismissedKey, 'done');
  localStorage.setItem('habibi.home-layout', JSON.stringify({ ...homeLayoutDefaults, suggestions:false, assistant:false }));
  if (demoScreen === 'search') {
    input.value = 'project brief';
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = '3 results';
    const files = [
      { icon:'file-text', title:'Project Aurora brief.pdf', meta:'Documents · ~/Documents/Strategy', tag:'FILE', type:'file', path:'/demo/Documents/Project Aurora brief.pdf' },
      { icon:'files', title:'Aurora launch notes.md', meta:'Documents · ~/Documents/Strategy', tag:'FILE', type:'file', path:'/demo/Documents/Aurora launch notes.md' },
      { icon:'files', title:'Project Aurora assets', meta:'Downloads · ~/Downloads', tag:'FOLDER', type:'file', path:'/demo/Downloads/Project Aurora assets' },
    ];
    setHtml(resultsView, `<section class="best-matches-region"><div class="result-header"><b>Best matches</b><span>1 result</span></div><div class="result-list">${resultButton(files[0], 0)}</div></section><section class="local-files-section"><div class="inline-section"><div class="result-header"><b>Local files</b><span>Spotlight index · 2 matches</span></div><div class="result-list">${files.slice(1).map((item, index) => resultButton(item, index + 1)).join('')}</div></div></section>`);
  } else if (demoScreen === 'preferences') {
    showSettings();
  } else {
    loadProactiveHome();
  }
  refreshIcons();
} else {
  loadProactiveHome();
  renderQuickSamples();
}
// The native panel is intentionally persistent for instant launch. Reset this
// transient UI state whenever it hides, so reopening Habibi always starts at
// the private home screen rather than inside a previous connector.
window.__habibiResetLauncher = () => { activeShortcutCapture?.(); showDefault(); input.focus({ preventScroll:true }); };
