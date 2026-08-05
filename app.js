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
const toast = document.querySelector('#toast');
const dropDock = document.querySelector('#drop-dock');
let activeTerminal = null;
let activeTerminalSocket = null;
let terminalResizeObserver = null;
let openwaStateKey = null;
let contactSearchSequence = 0;
let launcherMode = null;
let whatsappChats = [];
let whatsappSource = null;
let proactiveContext = { events:[], mail:[], provider:'' };
let mailInboxState = null;
let mailSearchTimer = null;
let mailSearchSequence = 0;
let activeShortcutCapture = null;
let commandSearchTimer = null;
const pastedTextAttachmentThreshold = 50;
const homeLayoutDefaults = Object.freeze({ header:true, briefing:true, calendar:true, mail:true, assistant:true, suggestions:true, footer:true, focusOnly:false });
const ephemeralHistoryKey = 'habibi.ephemeral-conversation-history.v1';
const iconNames = { whatsapp:'message-circle-more', calendar:'calendar-days', files:'folder', agents:'bot', gmail:'mail' };
const results = launcherResults;
const resultButton = createResultButton({ icon, chatTime, iconNames });
const { renderSearch } = createSearchFeature({ input, defaultView, resultsView, count, results, resultButton, refreshIcons });

function homeLayout() { try { return { ...homeLayoutDefaults, ...JSON.parse(localStorage.getItem('habibi.home-layout') || '{}') }; } catch (_) { return { ...homeLayoutDefaults }; } }
function applyHomeLayout() {
  const layout = homeLayout();
  const sections = {
    header:[document.querySelector('.topbar')],
    briefing:[document.querySelector('#proactive-briefing')],
    calendar:[document.querySelector('.agenda-home-header'), document.querySelector('#agenda-glance')],
    mail:[document.querySelector('#proactive-mail')],
    assistant:[document.querySelector('.proactive-footnote'), document.querySelector('.home-divider')],
    suggestions:[document.querySelector('#quick-samples')],
    footer:[document.querySelector('footer')],
  };
  Object.entries(sections).forEach(([id, nodes]) => nodes.filter(Boolean).forEach(node => node.classList.toggle('home-section-hidden', !layout[id])));
  const hasContext = Boolean(proactiveContext.events?.length || proactiveContext.mail?.length);
  defaultView.classList.toggle('home-focus-only', layout.focusOnly && !hasContext);
  window.webkit?.messageHandlers?.habibiNative?.postMessage({ type:'dragZones', headerVisible:layout.header });
}
function saveHomeLayout(id, visible) { const next = homeLayout(); next[id] = visible; localStorage.setItem('habibi.home-layout', JSON.stringify(next)); applyHomeLayout(); }
function showDefault() { clearTimeout(commandSearchTimer); activeShortcutCapture?.(); window.__habibiAttachPastedFiles = null; launcherMode=null; input.placeholder='Search anything, or ask Habibi…'; input.value=''; defaultView.classList.remove('hidden'); resultsView.classList.add('hidden'); count.textContent='6 skills available'; applyHomeLayout(); loadProactiveHome(); renderQuickSamples(); track('habibi.launcher.opened', { surface:'home', app_type:'native', app_version:'0.1.0' }); }
function dismissLauncher() {
  const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
  if (nativeBridge) nativeBridge.postMessage('dismiss');
  else { showDefault(); input.blur(); }
}
function shouldAttachPastedText(text) { return String(text || '').trim().length > pastedTextAttachmentThreshold; }
const themeCatalog = [
  { id:'deep-ocean', name:'Deep Ocean', description:'Calm navy glass', swatches:['#061426','#11518e','#8ebffb'] },
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
function showSettings() {
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
    ['assistant','Assistant','Habibi’s help area','bot'],
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
    if (result.saved) { document.body.dataset.nativeShortcutLabel = shortcutLabel(pendingShortcut); document.querySelector('#shortcut-current').textContent = shortcutLabel(pendingShortcut); candidateStatus.textContent = 'Saved — Habibi will use this globally.'; save.disabled = true; }
  };
  listen.onclick = () => { activeShortcutCapture?.(); listen.classList.add('listening'); listen.querySelector('b').textContent = 'Listening… press your shortcut'; candidate.classList.add('hidden'); activeShortcutCapture = stopListening; window.addEventListener('keydown', onShortcutKey, true); captureTimeout = setTimeout(() => { if (listen.classList.contains('listening')) { candidate.classList.remove('hidden'); candidateLabel.textContent = 'Stopped listening'; candidateStatus.textContent = 'Click once more whenever you are ready.'; stopListening(); } }, 12_000); };
  save.onclick = () => { if (pendingShortcut && native) window.webkit.messageHandlers.habibiNative.postMessage({ type:'shortcutSave', label:shortcutLabel(pendingShortcut), ...pendingShortcut }); };
  refreshIcons();
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
  if (result.dataset.type === 'app' && result.dataset.path) return fetch('/api/open-app', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ path:decodeURIComponent(result.dataset.path) }) }).then(response => response.json()).then(data => notify(data.ok ? `Opened ${result.dataset.title}` : `Could not open ${result.dataset.title}`));
  if (result.dataset.type === 'system') return showSystemAction(result.dataset.systemAction, result.dataset.title);
  if (result.dataset.type === 'folder') return openKnownFolder(result.dataset.folder);
  showAction(result.dataset.type, result.dataset.title, result.dataset.path && decodeURIComponent(result.dataset.path));
}
async function openKnownFolder(folder) {
  const result = await fetch('/api/open-folder', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ folder }) }).then(response => response.json()).catch(() => ({ ok:false }));
  notify(result.ok ? `Opened ${folder}` : `Could not open ${folder}`);
}
function showAction(type, title, filePath) {
  if (type === 'message' || type === 'whatsapp') return showChatClient();
  if (type === 'assistant') return showAgenticMessage(input.value);
  if (type === 'email') return showMailClient();
  if (type === 'event') return showEventDraft();
  if (type === 'agenda') return showUpcomingEvents();
  if (type === 'agent') return showAgentDock();
  if (type === 'file' && !filePath) { input.focus(); return notify('Type a filename to search your local Spotlight index'); }
  const actions = {
    file: { label:'LOCAL FILE', title, text:'Press Enter to open this file. Nothing leaves your Mac.', button:'Open file' },
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
    setHtml(details, `<div class="provider-detail"><div class="provider-detail-title"><b>${provider.label}</b><span>${provider.kind === 'local' ? 'Runs locally on this Mac' : 'Uses your own API key'}</span></div><div class="provider-fields"><label>Model <span class="model-combobox"><input id="llm-model" role="combobox" aria-expanded="false" aria-controls="llm-model-menu" value="${provider.model}" autocomplete="off" placeholder="Choose or type a model" /><button id="llm-model-trigger" aria-label="Show available models">${icon('chevron-down')}</button><span id="llm-model-menu" class="model-menu hidden" role="listbox"></span></span></label>${provider.kind === 'local' ? `<label>Server address <input id="llm-endpoint" value="${provider.endpoint}" autocomplete="off" /></label>` : `<label>API key <input id="llm-api-key" type="password" autocomplete="off" placeholder="Stored in macOS Keychain" /></label>`}</div><div class="provider-actions"><span id="llm-setup-message">${provider.kind === 'local' ? 'Looking for models on your local server…' : 'Your key is stored in macOS Keychain, never in Habibi.'}</span><button class="primary" id="save-llm">Continue <kbd>↵</kbd></button></div></div>`);
    const modelInput = document.querySelector('#llm-model');
    const modelMenu = document.querySelector('#llm-model-menu');
    const renderModels = (filter = '') => {
      const matching = availableModels.filter(model => model.toLowerCase().includes(filter.toLowerCase()));
      setHtml(modelMenu, matching.length ? matching.map((model, index) => `<button role="option" data-model="${escapeHtml(model)}" aria-selected="${index === 0}">${escapeHtml(model)}</button>`).join('') : '<span class="model-empty">Type any installed model name</span>');
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
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-habibi">${icon('arrow-left')} Habibi</button><span class="verified" id="habibi-provider">● checking model</span></div><section class="chat-client habibi-chat" id="habibi-ephemeral-chat"><div class="chat-title"><span class="icon agents">${icon('sparkles')}</span><span><b>Habibi</b><small>New private conversation · history saved locally</small></span><button class="history-button" id="configure-model">Model settings</button></div><div class="messages" id="habibi-messages"></div><div class="chat-composer"><div id="habibi-attachments" class="chat-attachments"></div><textarea id="habibi-draft" rows="2" placeholder="Ask anything…" disabled></textarea><input id="habibi-file-input" type="file" multiple hidden /><div><span id="habibi-composer-note">Checking your model…</span><span class="composer-actions"><button type="button" class="composer-icon" id="attach-habibi" title="Attach files" aria-label="Attach files" disabled>${icon('paperclip')}</button><button type="button" class="primary" id="send-habibi" disabled>Send <kbd>⌘ ↵</kbd></button></span></div></div></section>`);
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
    list.className = 'agent-file-results';
    setHtml(list, files.map(file => `<button type="button" data-path="${encodeURIComponent(file.path)}"><span class="icon files">${icon('file-text')}</span><span><b>${escapeHtml(file.name)}</b><small>${escapeHtml(file.folder)} · ${escapeHtml(file.directory)}</small></span><i>${icon('arrow-up-right')}</i></button>`).join(''));
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
    const response = await fetch('/api/agent/files/investigate', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ history:[...conversation, { role:'user', text:prompt }] }) });
    const result = await response.json();
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
  document.querySelector('#back-habibi').onclick = () => { window.__habibiAttachPastedFiles = null; showDefault(); };
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
  if (/\b(?:create|schedule|book|add)\b.*\b(?:calendar|meeting|event)\b|\b(?:calendar|meeting|event)\b.*\b(?:create|schedule|book|add)\b/i.test(message) || /\b(?:meeting|meet|appointment|call|lunch|dinner)\b/i.test(message) && /\b(?:next|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s*(?:am|pm)?\s*(?:-|to))\b/i.test(message)) return { kind:'calendar', source:command };
  if (/\b(?:email|gmail|mail)\b/i.test(message) && /\b(?:write|draft|reply|send)\b/i.test(message)) return { kind:'email' };
  return null;
}
function routeAppIntent(intent) {
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
  fetch('/api/whatsapp/chats').then(response => response.json()).then(data => {
    const chats = (data.chats || []).filter(chat => chat.kind !== 'status' && !chat.archived).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 100);
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
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-chats">${icon('arrow-left')} WhatsApp</button><span class="verified">● local session</span></div><section class="chat-client whatsapp-client"><div class="chat-title"><span class="icon chat-avatar" id="chat-avatar">${avatar}</span><span><b>${escapeHtml(chat.name || chat.id)}</b><small>Loading recent history…</small></span></div><div class="messages"><div class="loading-state"><span class="spinner"></span> Loading messages…</div></div><div class="chat-composer"><textarea id="message-draft" rows="2">${escapeHtml(draft)}</textarea><div><span>Only sent after you confirm</span><button type="button" class="primary" id="send-message">Send <kbd>⌘ ↵</kbd></button></div></div></section>`);
  document.querySelector('#back-chats').onclick = showWhatsAppChats;
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
    if (!text) return notify('Write a message first');
    const box = document.querySelector('.messages');
    const message = document.createElement('div');
    const body = document.createElement('span');
    const time = document.createElement('time');
    message.className = 'message outgoing sending';
    body.textContent = text;
    time.textContent = 'Sending…';
    message.append(body, time);
    box.append(message);
    box.scrollTop = box.scrollHeight;
    composer.value = '';
    composer.focus();
    let approvalToken;
    try { approvalToken = await requestApproval('whatsapp.send', { chatId:chat.id, text }); }
    catch (error) { message.remove(); composer.value = text; return notify(error.message); }
    fetch('/api/whatsapp/send', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ chatId:chat.id, text, approvalToken }) })
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
        notify(error.message || 'Could not send message');
      });
  };
  document.querySelector('#send-message').onclick = send;
  document.querySelector('#message-draft').addEventListener('keydown', event => { if (event.metaKey && event.key === 'Enter') send(); });
  refreshIcons();
  requestAnimationFrame(() => document.querySelector('#message-draft')?.focus());
}
function showAgentDock() {
  closeInteractiveTerminal();
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = 'Agent Dock · local';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-agent-dock">${icon('arrow-left')} Habibi</button><span class="verified">● local processes only</span></div><div id="agent-dock" class="agent-dock"><div class="loading-state"><span class="spinner"></span> Looking for Codex and Claude sessions…</div></div>`);
  document.querySelector('#back-agent-dock').onclick = showDefault;
  fetch('/api/agents').then(response => response.json()).then(data => {
    const dock = document.querySelector('#agent-dock');
    if (!dock) return;
    if (!data.ok) throw new Error('Unavailable');
    if (!data.agents.length) {
      setHtml(dock, `<div class="clear-day"><span class="icon agents">${icon('bot')}</span><span><b>No active Codex or Claude sessions.</b><small>When a local agent is running, Habibi will surface it here.</small></span></div>`);
    } else {
      setHtml(dock, data.agents.map(agent => `<button class="agent-session" data-agent="${encodeURIComponent(JSON.stringify(agent))}"><span class="icon agents">${icon('bot')}</span><span><b>${/claude/i.test(agent.command) ? 'Claude Code' : 'Codex'}</b><small>PID ${escapeHtml(agent.pid)} · running ${escapeHtml(agent.elapsed)}</small><code>${escapeHtml(agent.cwd || agent.command)}</code></span><i data-lucide="chevron-right"></i></button>`).join(''));
      dock.querySelectorAll('.agent-session').forEach(button => button.onclick = () => showAgentDetail(JSON.parse(decodeURIComponent(button.dataset.agent))));
    }
    refreshIcons();
  }).catch(() => { const dock = document.querySelector('#agent-dock'); if (dock) setHtml(dock, '<div class="searching-local">Agent processes are unavailable right now.</div>'); });
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
function showInteractiveTerminal(agent, kind, label) {
  closeInteractiveTerminal();
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-agent-detail">${icon('arrow-left')} ${label}</button><span class="verified">● interactive local PTY</span></div><section class="terminal-shell"><header><span>${icon('terminal-square')} ${escapeHtml(label)} · ${escapeHtml(agent.cwd)}</span><button id="close-terminal">End session</button></header><div id="terminal-host" aria-label="Interactive ${label} terminal"></div><footer><span>Type normally. <kbd>ctrl c</kbd> interrupts · session ends when you close it.</span><span id="terminal-status">Connecting…</span></footer></section>`);
  document.querySelector('#back-agent-detail').onclick = () => { closeInteractiveTerminal(); showAgentDetail(agent); };
  document.querySelector('#close-terminal').onclick = () => { closeInteractiveTerminal(); showAgentDetail(agent); };
  const host = document.querySelector('#terminal-host');
  if (!window.Terminal || !window.FitAddon) { host.textContent = 'Terminal renderer unavailable.'; return; }
  activeTerminal = new window.Terminal({ cursorBlink:true, fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize:12, theme:{ background:'#161617', foreground:'#e6e6e8', cursor:'#c9ff62', selectionBackground:'#4e4e52' } });
  const fit = new window.FitAddon.FitAddon(); activeTerminal.loadAddon(fit); activeTerminal.open(host); fit.fit();
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  activeTerminalSocket = new WebSocket(`${protocol}://${window.location.host}/pty`);
  const resize = () => { if (!activeTerminalSocket || activeTerminalSocket.readyState !== WebSocket.OPEN) return; fit.fit(); activeTerminalSocket.send(JSON.stringify({ type:'resize', cols:activeTerminal.cols, rows:activeTerminal.rows })); };
  terminalResizeObserver = new ResizeObserver(resize); terminalResizeObserver.observe(host);
  activeTerminalSocket.onopen = () => { activeTerminalSocket.send(JSON.stringify({ type:'start', cwd:agent.cwd, kind })); resize(); };
  activeTerminalSocket.onmessage = event => { const message = JSON.parse(event.data); if (message.type === 'data') activeTerminal.write(message.data); if (message.type === 'started') document.querySelector('#terminal-status').textContent = 'Running'; if (message.type === 'exit') document.querySelector('#terminal-status').textContent = `Exited (${message.exitCode})`; if (message.type === 'error') activeTerminal.write(`\r\nError: ${message.message}\r\n`); };
  activeTerminalSocket.onclose = () => { const status = document.querySelector('#terminal-status'); if (status && status.textContent === 'Connecting…') status.textContent = 'Disconnected'; };
  activeTerminal.onData(data => activeTerminalSocket?.readyState === WebSocket.OPEN && activeTerminalSocket.send(JSON.stringify({ type:'input', data })));
  setTimeout(() => { resize(); activeTerminal.focus(); }, 50);
  refreshIcons();
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
function loadProactiveHome() {
  const glance = document.querySelector('#agenda-glance');
  if (!glance) return;
  const now = new Date();
  proactiveContext = { events:[], mail:[], provider:'' };
  document.querySelector('#home-date').textContent = now.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' }).toUpperCase();
  setHtml(glance, '<div class="loading-state"><span class="spinner"></span> Checking your calendar…</div>');
  const briefing = document.querySelector('#proactive-briefing');
  if (briefing) setHtml(briefing, '<div class="loading-state"><span class="spinner"></span> Checking recent context…</div>');
  loadCalendarEvents().then(data => {
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
  fetch('/api/mail/status').then(response => response.json()).then(data => {
    const accounts = (data.accounts || []).filter(item => item.connected);
    if (!accounts.length) return;
    return fetch('/api/mail/recent?provider=all&hours=4').then(response => response.json()).then(recent => {
      if (!recent.ok) return;
      proactiveContext.mail = recent.threads || [];
      proactiveContext.provider = 'all';
      renderProactiveBriefing();
    });
  }).catch(() => {}).finally(() => {
    if (!proactiveContext.events.length && !proactiveContext.mail.length) renderProactiveBriefing();
  });
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
      if (button) { button.disabled = false; button.querySelector('small').textContent = 'Allow Calendar access'; }
      notify(result?.message || 'Calendar access was not granted.');
      return;
    }
    loadProactiveHome();
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
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-whatsapp-client">${icon('arrow-left')} Habibi</button><span class="verified">● checking local service</span></div><div class="loading-state"><span class="spinner"></span> Checking OpenWA on this Mac…</div>`);
  document.querySelector('#back-whatsapp-client').onclick = showDefault;
  fetch('/api/openwa/status').then(response => response.json()).then(status => {
    if (status.ok && status.session?.status === 'ready') return showWhatsAppChats();
    if (status.ok && !status.session) {
      setHtml(resultsView, `<div class="result-header conversation-mode"><b>WhatsApp</b><span class="verified">● local setup</span></div><div class="loading-state"><span class="spinner"></span> Starting your private WhatsApp session…</div>`);
      return fetch('/api/openwa/connect', { method:'POST' }).then(response => response.json()).then(showOpenWASetup);
    }
    showOpenWASetup(status);
  }).catch(() => showOpenWASetup({ ok:false }));
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
input.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('.system-action-confirm') && !document.querySelector('#quick-preview')) { event.preventDefault(); dismissLauncher(); return; } if (event.key === 'ArrowDown') { event.preventDefault(); resultsView.classList.contains('hidden') ? keyboard.navigateKeyboard(1) : keyboard.navigateResults(1, launcherMode !== 'whatsapp'); } if (event.key === 'ArrowUp') { event.preventDefault(); resultsView.classList.contains('hidden') ? keyboard.navigateKeyboard(-1) : keyboard.navigateResults(-1, launcherMode !== 'whatsapp'); } if (event.key === 'Enter' && !resultsView.classList.contains('hidden')) { event.preventDefault(); activateResult(document.querySelector('.result.selected') || document.querySelector('.result')); } });
document.addEventListener('dragstart', event => {
  const result = event.target.closest('.result[data-path]');
  if (!result) return;
  const path = decodeURIComponent(result.dataset.path);
  const localUrl = `${window.location.origin}/api/file?path=${encodeURIComponent(path)}`;
  event.dataTransfer.setData('application/x-habibi-file', path);
  event.dataTransfer.setData('application/x-habibi-name', result.dataset.title);
  event.dataTransfer.setData('text/plain', localUrl);
  event.dataTransfer.setData('text/uri-list', localUrl);
  event.dataTransfer.setData('DownloadURL', `application/octet-stream:${result.dataset.title}:${localUrl}`);
  event.dataTransfer.effectAllowed='copyLink';
  dropDock.classList.add('visible');
});
document.addEventListener('dragend', () => dropDock.classList.remove('visible'));
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
document.addEventListener('click', event => { const action = event.target.closest('.quick-action'); if (action) { input.value=action.dataset.command; renderSearch(input.value); } const result = event.target.closest('.result'); if (result) activateResult(result); const connect = event.target.closest('[data-connect]'); if (connect) notify(`${connect.dataset.connect} setup will open in the native app`); });
document.querySelector('#manage-button').onclick = showSkills;
document.querySelector('#open-settings').onclick = showSettings;
document.querySelector('#open-agenda').onclick = showUpcomingEvents;
document.querySelectorAll('[data-sample]').forEach(button => button.onclick = () => { input.value = button.dataset.sample; markActivity(); renderSearch(input.value); });
window.addEventListener('keydown', event => {
  if (event.defaultPrevented) return;
  const confirmation = document.querySelector('.system-action-confirm');
  if (confirmation) {
    const select = choice => { confirmation.dataset.confirmChoice = choice; confirmation.querySelectorAll('.confirmation-choice').forEach(button => button.classList.toggle('selected', button.dataset.choice === choice)); };
    if (event.key === 'Escape') { event.preventDefault(); document.querySelector('#back-system-action')?.click(); return; }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); select(event.key === 'ArrowLeft' ? 'confirm' : 'cancel'); return; }
    if (event.key === 'Enter') { event.preventDefault(); (confirmation.dataset.confirmChoice === 'cancel' ? document.querySelector('#cancel-system-action') : document.querySelector('#confirm-system-action'))?.click(); return; }
  }
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
loadProactiveHome();
renderQuickSamples();
// The native panel is intentionally persistent for instant launch. Reset this
// transient UI state whenever it hides, so reopening Habibi always starts at
// the private home screen rather than inside a previous connector.
window.__habibiResetLauncher = () => { activeShortcutCapture?.(); showDefault(); input.focus({ preventScroll:true }); };
