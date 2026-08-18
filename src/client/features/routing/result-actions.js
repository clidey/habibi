import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';
import { setHtml } from '../../core/safe-dom.js';
import { track } from '../../core/analytics.js';

export function createResultActions(deps) {
  const { input, resultsView, notify, getMode, onHome, settings, mail, whatsapp, whatsappSetup, platformActions, kubernetes, agentSessions, calendar, skills, intentRouter } = deps;
  async function showAction(type, title, filePath) {
    if (type === 'message' || type === 'whatsapp') return whatsappSetup.show();
    if (type === 'assistant') return intentRouter.showAgentic(input.value);
    if (type === 'email') return mail.showClient();
    if (type === 'event') return calendar.showDraft();
    if (type === 'agenda') return calendar.showUpcoming();
    if (type === 'agent') return agentSessions.showDock();
    if (type === 'skills') return skills.show();
    if (type === 'preferences') return settings.show();
    if (type === 'file' && !filePath) { input.focus(); return notify('Type a filename to search your local Spotlight index'); }
    if (type === 'file' && filePath) {
      try {
        const response = await fetch('/api/open-file', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ path:filePath }) });
        const result = await response.json();
        notify(result.ok ? `Opened ${title}` : 'Could not open that file');
      } catch (_) { notify('Could not open that file'); }
      return;
    }
    setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-action">${icon('arrow-left')} Habibi</button><span>External actions need approval</span></div><div class="compose"><span class="compose-label">Action unavailable</span><h2>${escapeHtml(title || 'Habibi')}</h2><p>This action is not available yet.</p><div class="compose-actions"><button class="secondary" id="cancel">Back</button></div></div>`);
    document.querySelector('#back-action').onclick = onHome;
    document.querySelector('#cancel').onclick = onHome;
    refreshIcons();
  }
  function activate(result) {
    if (!result) return;
    track('habibi.result.opened', { result_type:String(result.dataset.type || 'unknown').slice(0, 32), surface:getMode() || 'search', app_type:'native', app_version:'0.1.0' });
    if (result.dataset.mailThread) return mail.showThread(result.dataset.mailThread, result.dataset.mailProvider);
    if (result.dataset.type === 'chat' && result.dataset.chat) {
      const chat = JSON.parse(decodeURIComponent(result.dataset.chat));
      const intent = getMode() === 'whatsapp' ? whatsapp.intentFromSearch(chat, input.value) : null;
      whatsapp.showChat(chat);
      if (intent?.instruction) whatsapp.draftMessage(chat, intent.instruction, input.value);
      return;
    }
    if (result.dataset.type === 'app' && result.dataset.path) return platformActions.openApp(result);
    if (result.dataset.type === 'kubernetes') return kubernetes.show(input.value);
    if (['codex', 'claude'].includes(result.dataset.type)) return agentSessions.showSessions(result.dataset.type);
    if (result.dataset.type === 'system') {
      if (result.dataset.systemAction === 'quitApps') return platformActions.showRunning('quit');
      if (result.dataset.systemAction === 'forceQuitApps') return platformActions.showRunning('force');
      return platformActions.showSystem(result.dataset.systemAction, result.dataset.title);
    }
    if (result.dataset.type === 'preferences') return settings.show();
    if (result.dataset.type === 'folder') return platformActions.openFolder(result.dataset.folder);
    showAction(result.dataset.type, result.dataset.title, result.dataset.path && decodeURIComponent(result.dataset.path));
  }
  return { activate, showAction };
}
