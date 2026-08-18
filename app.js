import { chatTime, escapeHtml, icon, refreshIcons } from './src/client/core/view-helpers.js';
import { setHtml } from './src/client/core/safe-dom.js';
import { launcherResults } from './src/client/data/launcher-results.js';
import { createResultButton } from './src/client/ui/result-button.js';
import { createSearchFeature } from './src/client/features/search/search-feature.js';
import { createModelSetupFeature } from './src/client/features/llm/model-setup-feature.js';
import { createAiChatFeature } from './src/client/features/llm/ai-chat-feature.js';
import { createCalendarFeature } from './src/client/features/calendar/calendar-feature.js';
import { createMailFeature } from './src/client/features/mail/mail-feature.js';
import { createWhatsAppChatsFeature } from './src/client/features/whatsapp/whatsapp-chats-feature.js';
import { createWhatsAppSetupFeature } from './src/client/features/whatsapp/whatsapp-setup-feature.js';
import { previewFile as openFilePreview } from './src/client/features/files/file-preview.js';
import { createSkillsFeature } from './src/client/features/skills/skills-feature.js';
import { createIntentRouter } from './src/client/features/routing/intent-router.js';
import { track } from './src/client/core/analytics.js';
import { createKubernetesFeature } from './src/client/features/kubernetes/kubernetes-feature.js';
import { createAgentSessionsFeature } from './src/client/features/agents/agent-sessions-feature.js';
import { createPlatformActionsFeature } from './src/client/features/system/platform-actions-feature.js';
import { createSettingsFeature } from './src/client/features/settings/settings-feature.js';
import { installClipboardImageBridge, pastedImageFiles, requestNativeClipboardImage } from './src/client/core/clipboard-images.js';
import { createResultActions } from './src/client/features/routing/result-actions.js';
import { installFileDrag } from './src/client/features/files/file-drag.js';
import { installAppInteractions } from './src/client/app-interactions.js';
import { initializeDemoMode } from './src/client/demo-mode.js';

const input = document.querySelector('#command-input');
const defaultView = document.querySelector('#default-view');
const resultsView = document.querySelector('#results-view');
const count = document.querySelector('#result-count');
const updateButton = document.querySelector('#update-available');
let updateState = null;
const toast = document.querySelector('#toast');
const dropDock = document.querySelector('#drop-dock');
let launcherMode = null;
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
const onboardingDismissedKey = 'habibi.getting-started.dismissed.v1';
const onboardingShortcutKey = 'habibi.getting-started.shortcut-set.v1';
const onboardingPreviewKey = 'habibi.getting-started.preview.v1';
const iconNames = { whatsapp:'message-circle-more', calendar:'calendar-days', files:'folder', agents:'bot', gmail:'mail', kubernetes:'ship-wheel' };
const results = launcherResults;
const resultButton = createResultButton({ icon, chatTime, iconNames });
const { renderSearch } = createSearchFeature({ input, defaultView, resultsView, count, results, resultButton, refreshIcons });
const kubernetes = createKubernetesFeature({ input, defaultView, resultsView, count, onBack:showDefault, onOpen:() => { launcherMode = 'kubernetes'; } });
const agentSessions = createAgentSessionsFeature({ input, defaultView, resultsView, count, notify, onBack:showDefault, onOpen:() => { launcherMode = 'agent-sessions'; } });
const platformActions = createPlatformActionsFeature({ input, defaultView, resultsView, count, notify, requestApproval, requestNativeLockScreen, onBack:showDefault, onOpen:mode => { launcherMode = mode; } });
let mail;
let modelSetup;
let intentRouter;
const calendar = createCalendarFeature({ defaultView, resultsView, count, notify, requestApproval, applyHomeLayout, onBack:showDefault, onMailThread:(...args) => mail.showThread(...args), demoMode, demoEvents, demoMail });
mail = createMailFeature({ input, defaultView, resultsView, count, notify, requestApproval, onHome:showDefault, onOpen:(mode = 'mail') => { launcherMode = mode; }, onPreview:(path, name) => openFilePreview(path, name, notify) });
const aiChat = createAiChatFeature({ input, defaultView, resultsView, count, notify, calendar, mail, onHome:showDefault, onOpen:() => { launcherMode = 'habibi-chat'; }, openModelSetup:options => modelSetup.show(options), getIntentRouter:() => intentRouter, pastedImageFiles, requestNativeClipboardImage });
modelSetup = createModelSetupFeature({ defaultView, resultsView, count, onBack:showDefault, onChat:aiChat.show, onOpen:() => { launcherMode = 'llm-setup'; } });
const whatsappChatsFeature = createWhatsAppChatsFeature({ input, resultsView, count, resultButton, notify, requestApproval, isActive:() => launcherMode === 'whatsapp', onOpen:() => { launcherMode = 'whatsapp'; } });
const whatsappSetup = createWhatsAppSetupFeature({ defaultView, resultsView, count, onChats:whatsappChatsFeature.showChats, onHome:showDefault });
const skills = createSkillsFeature({ input, defaultView, resultsView, count, notify, requestApproval, onHome:showDefault, onOpen:mode => { launcherMode = mode; } });
intentRouter = createIntentRouter({ input, defaultView, resultsView, count, notify, kubernetes, calendar, mail, whatsapp:whatsappChatsFeature, onChat:aiChat.show, onHome:showDefault });
const settings = createSettingsFeature({ input, defaultView, resultsView, count, notify, homeLayout, saveHomeLayout, modelSetup, whatsappSetup, mail, calendar, onHome:showDefault, onOpen:() => { launcherMode = 'settings'; }, onRestartOnboarding:reopenGettingStarted });
const resultActions = createResultActions({ input, resultsView, notify, getMode:() => launcherMode, onHome:showDefault, settings, mail, whatsapp:whatsappChatsFeature, whatsappSetup, platformActions, kubernetes, agentSessions, calendar, skills, intentRouter });
installClipboardImageBridge({ notify, onFiles:files => aiChat.show('', { files }) });
installFileDrag({ dropDock, notify, onFiles:files => aiChat.show('', { files }), onComposeMail:(path, name) => mail.showComposer('New email', { path, name }) });

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
  const hasContext = calendar.hasContext();
  defaultView.classList.toggle('home-focus-only', layout.focusOnly && !hasContext);
  window.webkit?.messageHandlers?.habibiNative?.postMessage({ type:'dragZones', headerVisible:layout.header });
}
function saveHomeLayout(id, visible) { const next = homeLayout(); next[id] = visible; localStorage.setItem('habibi.home-layout', JSON.stringify(next)); applyHomeLayout(); }
function showDefault() { kubernetes.stop(); agentSessions.close(); settings?.close(); window.__habibiAttachPastedFiles = null; launcherMode=null; input.placeholder='Search anything, or ask Habibi…'; input.value=''; defaultView.classList.remove('hidden'); resultsView.classList.add('hidden'); count.textContent='6 skills available'; applyHomeLayout(); loadGettingStarted(); calendar.loadHome(); renderQuickSamples(); track('habibi.launcher.opened', { surface:'home', app_type:'native', app_version:'0.1.0' }); }
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
  // All four checks resolve together before anything but the spinner paints —
  // rendering steps incrementally as each settled would show a populated
  // checklist, then flash to incomplete, then resettle, before the user has
  // done anything. Running the native bridge round-trip alongside the network
  // checks (rather than waiting on it first) also means the checklist doesn't
  // wait on whichever one happens to be slowest twice over.
  const [launchAtLogin, mail, whatsapp, llm] = await Promise.all([
    new Promise(resolve => {
      const bridge = window.webkit?.messageHandlers?.habibiNative;
      if (!bridge) return resolve(false);
      const timeout = setTimeout(() => resolve(false), 1_500);
      window.__habibiLaunchAtLoginState = result => { clearTimeout(timeout); resolve(Boolean(result?.enabled)); };
      bridge.postMessage({ type:'launchAtLoginState' });
    }),
    fetch('/api/mail/status').then(response => response.json()).catch(() => ({ accounts:[] })),
    fetch('/api/openwa/status').then(response => response.json()).catch(() => ({ session:null })),
    fetch('/api/llm/status').then(response => response.json()).catch(() => ({ configured:false })),
  ]);
  if (target !== document.querySelector('#getting-started') || localStorage.getItem(onboardingDismissedKey) === 'done') return;
  const steps = [
    { id:'shortcut', icon:'keyboard', title:'Choose your shortcut', detail:'Open Habibi from anywhere', done:Boolean(localStorage.getItem(onboardingShortcutKey)), action:'shortcut', cta:'Set shortcut' },
    { id:'login', icon:'power', title:'Start at login', detail:'Keep Habibi ready in your menu bar', done:launchAtLogin, action:'login', cta:'Enable' },
    { id:'model', icon:'sparkles', title:'Connect a model', detail:'Use local models or your own provider', done:Boolean(llm.configured), action:'model', cta:'Connect model' },
    { id:'mail', icon:'mail', title:'Connect your mail', detail:'Search and reply from one place', done:(mail.accounts || []).some(account => account.connected), action:'mail', cta:'Connect mail' },
    { id:'whatsapp', icon:'message-circle-more', title:'Connect WhatsApp', detail:'Find chats and draft messages locally', done:whatsapp.session?.status === 'ready', action:'whatsapp', cta:'Connect WhatsApp' },
  ];
  if (steps.every(step => step.done) && !preview) { localStorage.setItem(onboardingDismissedKey, 'done'); target.classList.add('hidden'); setHtml(target, ''); return; }
  setHtml(target, `<div class="getting-started-heading"><span><span class="briefing-heading">GETTING STARTED</span><b>Make Habibi yours</b><small>Set up only what you want. You can come back to this any time.</small></span><button type="button" class="getting-started-dismiss" id="dismiss-getting-started">Not now</button></div><div class="getting-started-steps">${steps.map(step => `<button type="button" class="getting-started-step ${step.done ? 'complete' : ''}" data-onboarding-action="${step.action}"><span class="getting-started-icon">${icon(step.done ? 'check' : step.icon)}</span><span><b>${escapeHtml(step.title)}</b><small>${escapeHtml(step.done ? 'Ready' : step.detail)}</small></span><em>${step.done ? 'DONE' : escapeHtml(step.cta)}</em><i>${icon('chevron-right')}</i></button>`).join('')}</div>`);
  document.querySelector('#dismiss-getting-started')?.addEventListener('click', () => { localStorage.setItem(onboardingDismissedKey, 'done'); localStorage.removeItem(onboardingPreviewKey); target.classList.add('hidden'); });
  target.querySelectorAll('[data-onboarding-action]').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.onboardingAction;
    if (action === 'shortcut') return settings.show({ focus:'shortcut' });
    if (action === 'login') {
      const bridge = window.webkit?.messageHandlers?.habibiNative;
      if (!bridge) return;
      window.__habibiLaunchAtLoginState = result => {
        notify(result?.message || 'Updated start at login.');
        loadGettingStarted();
      };
      bridge.postMessage({ type:'launchAtLogin', enabled:true });
      return;
    }
    if (action === 'mail') return mail.showClient();
    if (action === 'whatsapp') return whatsappSetup.show();
    if (action === 'model') return modelSetup.show({ afterConfigured:showDefault });
  }));
  refreshIcons();
}
function dismissLauncher() {
  const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
  if (nativeBridge) nativeBridge.postMessage('dismiss');
  else { showDefault(); input.blur(); }
}
function markActivity() {
  localStorage.setItem('habibi.lastActivity', String(Date.now()));
  renderQuickSamples();
}
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
const keyboard = installAppInteractions({ input, defaultView, resultsView, notify, getMode:() => launcherMode, onHome:showDefault, onDismiss:dismissLauncher, onActivity:markActivity, renderSearch, whatsapp:whatsappChatsFeature, mail, platformActions, kubernetes, aiChat, resultActions, openFilePreview:(path, title) => openFilePreview(path, title, notify) });
document.querySelector('#open-settings').onclick = settings.show;
document.querySelector('#open-preferences').onclick = settings.show;
window.__habibiOpenPreferences = () => settings.show();
document.querySelector('#open-agenda').onclick = calendar.showUpcoming;
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
    if (document.querySelector('#back-chats')) return whatsappChatsFeature.showChats();
    if (document.querySelector('#habibi-ephemeral-chat')) return showDefault();
    if (launcherMode === 'whatsapp') return showDefault();
  }
  if (event.metaKey && event.key.toLowerCase() === 'n' && launcherMode === 'mail') { event.preventDefault(); mail.showComposer('Mail'); return; }
  if (event.metaKey && event.key === 'ArrowDown' && !resultsView.classList.contains('hidden')) { event.preventDefault(); keyboard.jumpToLocalFiles(); return; }
  if (event.altKey && event.code === 'Space') { event.preventDefault(); input.focus(); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase()==='k') { event.preventDefault(); input.focus(); }
});
input.focus();
settings.applyTheme();
settings.applyColorMode();
refreshIcons();
initializeDemoMode({ demoMode, demoScreen, homeLayoutDefaults, input, defaultView, resultsView, count, resultButton, settings, calendar, renderQuickSamples });
// The native panel is intentionally persistent for instant launch. Reset this
// transient UI state whenever it hides, so reopening Habibi always starts at
// the private home screen rather than inside a previous connector.
window.__habibiResetLauncher = () => { settings.close(); showDefault(); input.focus({ preventScroll:true }); };
