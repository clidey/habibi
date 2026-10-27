import { countBucket, track } from '../../core/analytics.js';
import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';
import { calendarDraftFromText } from '../calendar/event-intent.js';
import { fileResultsMarkup } from './file-results-view.js';

export function createChatTools({
  messages,
  conversation,
  addTurn,
  notify,
  calendar,
  mail,
  getIntentRouter,
}) {
  const addProposal = (proposal, sourceText) => {
    if (!proposal) return;
    const card = document.createElement('section');
    card.className = 'agent-proposal';
    setHtml(
      card,
      `<span class="icon agents">${icon(proposal.kind === 'calendar_draft' ? 'calendar-days' : proposal.kind === 'email_draft' ? 'mail' : 'whatsapp')}</span><span><b>${escapeHtml(proposal.label)} available</b><small>${escapeHtml(proposal.detail)}</small></span><button type="button">Prepare draft</button>`,
    );
    card.querySelector('button').onclick = () => {
      if (proposal.kind === 'calendar_draft')
        return calendar.showDraft(calendarDraftFromText(sourceText));
      if (proposal.kind === 'email_draft') return mail.showClient({ compose: true });
      const intent = getIntentRouter().parse(sourceText);
      if (intent?.kind === 'whatsapp') return getIntentRouter().route(intent);
      notify('Tell Habibi who the message is for to prepare the local draft.');
    };
    messages.append(card);
    messages.scrollTop = messages.scrollHeight;
    refreshIcons();
  };
  const addFileCandidates = (files) => {
    if (!files.length) return;
    const list = document.createElement('div');
    list.className = 'agent-file-results';
    setHtml(list, fileResultsMarkup(files));
    list.querySelectorAll('[data-path]').forEach(
      (button) => {
        button.title = decodeURIComponent(button.dataset.path);
        button.onclick = async () => {
          const result = await fetch('/api/open-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: decodeURIComponent(button.dataset.path) }),
          })
            .then((response) => response.json())
            .catch(() => ({ ok: false }));
          notify(result.ok ? 'Opened local file' : 'Could not open that file');
        };
      },
    );
    messages.append(list);
    // Start at the best matches and their heading rather than jumping to the last file.
    messages.scrollTop += list.getBoundingClientRect().top - messages.getBoundingClientRect().top;
    refreshIcons();
  };
  const addAgentTrace = (trace) => {
    if (!trace?.length) return;
    const panel = document.createElement('details');
    panel.className = 'agent-trace';
    setHtml(
      panel,
      `<summary>${icon('route')} Local investigation <span>${trace.length} step${trace.length === 1 ? '' : 's'}</span></summary><ol>${trace.map((step) => `<li><span>${icon('check')}</span><span><b>${escapeHtml(step.tool)}</b><small>${escapeHtml(step.detail)}</small></span></li>`).join('')}</ol>`,
    );
    messages.append(panel);
    messages.scrollTop = messages.scrollHeight;
    refreshIcons();
  };
  const investigateFiles = async (prompt) => {
    track('habibi.file-investigation.started', {
      surface: 'assistant',
      app_type: 'native',
      app_version: '0.1.0',
    });
    // Finder/TCC may ask for Desktop, Documents, or Downloads while this
    // request is running. Tell the native host first so its ordinary
    // click-away behavior does not dismiss the exact conversation that asked.
    const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
    nativeBridge?.postMessage({ type: 'permissionFlow', active: true });
    let result;
    try {
      const response = await fetch('/api/agent/files/investigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: [...conversation, { role: 'user', text: prompt }] }),
      });
      result = await response.json();
    } finally {
      nativeBridge?.postMessage({ type: 'permissionFlow', active: false });
    }
    if (!result.ok || result.phase === 'not_applicable') return false;
    if (result.phase === 'clarify') {
      const question = result.question || 'What detail would help narrow the local search?';
      conversation.push({ role: 'user', text: prompt }, { role: 'assistant', text: question });
      addAgentTrace(result.trace);
      addTurn('assistant', question);
      track('habibi.file-investigation.completed', {
        outcome: 'clarify',
        trace_step_count_bucket: countBucket(result.trace?.length || 0),
        app_type: 'native',
        app_version: '0.1.0',
      });
      return true;
    }
    const summary = result.summary || 'I searched your local files.';
    conversation.push({ role: 'user', text: prompt }, { role: 'assistant', text: summary });
    addAgentTrace(result.trace);
    addTurn('assistant', summary);
    addFileCandidates(result.files || []);
    track('habibi.file-investigation.completed', {
      outcome: (result.files || []).length ? 'results' : 'empty',
      file_candidate_count_bucket: countBucket((result.files || []).length),
      trace_step_count_bucket: countBucket(result.trace?.length || 0),
      app_type: 'native',
      app_version: '0.1.0',
    });
    return true;
  };
  return { addProposal, investigateFiles };
}
