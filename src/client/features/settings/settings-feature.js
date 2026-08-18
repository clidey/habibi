import { analyticsEnabled, setAnalyticsEnabled, track } from '../../core/analytics.js';
import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';
import { llmProviders } from '../llm/provider-catalog.js';

const onboardingShortcutKey = 'habibi.getting-started.shortcut-set.v1';

/** Owns appearance, home layout, integrations, analytics, shortcut, and startup preferences. */
export function createSettingsFeature({ input, defaultView, resultsView, count, notify, homeLayout, saveHomeLayout, modelSetup, whatsappSetup, mail, calendar, onHome, onOpen, onRestartOnboarding }) {
  let activeShortcutCapture = null;
const themeCatalog = [
  { id:'deep-ocean', name:'Clidey Ink', description:'Brand navy, lifted blue', swatches:['#0E2240','#2C6BD4','#5091FD'] },
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
function showSettings({ focus } = {}) {
  track('habibi.settings.opened', { surface:'settings', app_type:'native', app_version:'0.1.0' });
  activeShortcutCapture?.();
  onOpen(); defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = 'Settings';
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
  const integrationsSection = document.createElement('section');
  integrationsSection.className = 'settings-section integrations-settings';
  setHtml(integrationsSection, `<div class="appearance-heading"><span class="briefing-heading">CONNECTED SERVICES</span><small>Manage local capabilities and accounts.</small></div><div class="integration-settings-list"><button class="integration-setting" type="button" data-settings-service="model"><span class="home-layout-icon">${icon('sparkles')}</span><span><b>AI model</b><small id="settings-model-status">Checking configured model…</small></span><i>${icon('chevron-right')}</i></button><button class="integration-setting" type="button" data-settings-service="whatsapp"><span class="home-layout-icon whatsapp">${icon('message-circle-more')}</span><span><b>WhatsApp</b><small>Open chats or manage the local session.</small></span><i>${icon('chevron-right')}</i></button><button class="integration-setting" type="button" data-settings-service="mail"><span class="home-layout-icon gmail">${icon('mail')}</span><span><b>Mail accounts</b><small id="settings-mail-status">Checking connected inboxes…</small></span><i>${icon('chevron-right')}</i></button><button class="integration-setting" type="button" data-settings-service="calendar"><span class="home-layout-icon calendar">${icon('calendar-days')}</span><span><b>Calendar</b><small>View upcoming events or grant Calendar access.</small></span><i>${icon('chevron-right')}</i></button></div>`);
  settingsSections[0]?.after(integrationsSection);
  integrationsSection.querySelectorAll('[data-settings-service]').forEach(button => button.onclick = () => {
    const service = button.dataset.settingsService;
    if (service === 'model') return modelSetup.show({ afterConfigured:showSettings });
    if (service === 'whatsapp') return whatsappSetup.show({ onBack:showSettings });
    if (service === 'mail') return mail.showSettings({ onBack:showSettings });
    if (service === 'calendar') return calendar.showUpcoming({ onBack:showSettings });
  });
  fetch('/api/llm/status').then(response => response.json()).then(status => {
    const target = integrationsSection.querySelector('#settings-model-status');
    if (target) target.textContent = status.configured ? `${llmProviders[status.provider]?.label || 'Model'} · ${status.model || 'configured'}` : 'Connect Ollama, LM Studio, or your own provider.';
  }).catch(() => {});
  fetch('/api/mail/status').then(response => response.json()).then(status => {
    const target = integrationsSection.querySelector('#settings-mail-status');
    const accounts = (status.accounts || []).filter(account => account.connected);
    if (target) target.textContent = accounts.length ? accounts.map(account => account.email).join(' · ') : 'Connect Gmail or Zoho Mail with IMAP.';
  }).catch(() => {});
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
  if (native) {
    const launchAtLoginSection = document.createElement('section');
    launchAtLoginSection.className = 'settings-section home-layout-settings';
    setHtml(launchAtLoginSection, `<div class="appearance-heading"><span class="briefing-heading">STARTUP</span><small>Runs quietly in the menu bar after you sign in.</small></div><label class="home-layout-control"><span class="home-layout-icon">${icon('power')}</span><span><b>Start Habibi at login</b><small id="launch-at-login-note">Checking macOS setting…</small></span><input type="checkbox" id="launch-at-login" aria-label="Start Habibi at login" /></label>`);
    onboardingSection.before(launchAtLoginSection);
    const toggle = launchAtLoginSection.querySelector('#launch-at-login');
    const note = launchAtLoginSection.querySelector('#launch-at-login-note');
    window.__habibiLaunchAtLoginState = result => {
      if (!toggle?.isConnected) return;
      toggle.checked = Boolean(result?.enabled);
      toggle.disabled = false;
      note.textContent = result?.message || (result?.enabled ? 'Habibi opens from the menu bar after login.' : 'Habibi stays closed until you open it.');
    };
    toggle.addEventListener('change', event => {
      toggle.disabled = true;
      note.textContent = event.currentTarget.checked ? 'Enabling start at login…' : 'Disabling start at login…';
      window.webkit.messageHandlers.habibiNative.postMessage({ type:'launchAtLogin', enabled:event.currentTarget.checked });
    });
    window.webkit.messageHandlers.habibiNative.postMessage({ type:'launchAtLoginState' });
  }
  onboardingSection.querySelector('#restart-getting-started').onclick = onRestartOnboarding;
  layoutSection.querySelectorAll('[data-home-layout]').forEach(toggle => toggle.addEventListener('change', () => saveHomeLayout(toggle.dataset.homeLayout, toggle.checked)));
  document.querySelector('#back-settings').onclick = () => { activeShortcutCapture?.(); onHome(); };
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

  return { applyColorMode, applyTheme, close:() => activeShortcutCapture?.(), show:showSettings };
}
