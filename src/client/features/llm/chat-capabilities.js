import { setHtml } from '../../core/safe-dom.js';
import { spinner } from '../../core/view-helpers.js';

/** One model decision selects a capability; ordinary replies never probe local files. */
export function createChatCapabilities({ messages, conversation, addTurn, tools, getIntentRouter, openModelSetup, reopen, getModelProvider }) {
  function modelFailure(message, prompt) {
    addTurn('assistant', message);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = 'Model settings';
    button.onclick = () => openModelSetup({ provider: getModelProvider() || undefined, afterConfigured: () => reopen(prompt) });
    messages.lastElementChild?.append(button);
  }
  return {
    async handle(text, draft) {
      const pending = document.createElement('div');
      pending.className = 'message incoming thinking';
      setHtml(pending, spinner(true) + ' Preparing that…');
      messages.append(pending);
      messages.scrollTop = messages.scrollHeight;
      let route;
      try {
        route = await fetch('/api/agent/route', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, context: [...conversation].reverse().find(turn => turn.role === 'user')?.text || '' }),
        }).then(response => response.json());
      } catch {
        modelFailure('I could not plan that action. Check your model connection and try again.', text);
        return true;
      } finally { pending.remove(); }
      if (!route.ok) {
        if (route.needsConfiguration) openModelSetup({ afterConfigured: () => reopen(text) });
        else modelFailure(route.error || 'I could not reach the configured model. Check Model settings and try again.', text);
        return true;
      }
      if (route.action === 'chat') return false;
      draft.value = '';
      addTurn('user', text);
      try {
        if (route.action === 'clarify') {
          conversation.push({ role: 'user', text }, { role: 'assistant', text: route.question });
          addTurn('assistant', route.question);
        } else if (route.action === 'local_files') {
          if (!(await tools.investigateFiles(text))) addTurn('assistant', 'What local filename or document should I search for?');
        } else {
          const outcome = await getIntentRouter().execute(route, text);
          if (!outcome?.navigated) {
            const reply = outcome?.ok ? outcome.message || 'Done.' : outcome?.error || 'I could not complete that action. Try again.';
            addTurn('assistant', reply);
            conversation.push({ role: 'user', text }, { role: 'assistant', text: reply });
          }
        }
      } catch { addTurn('assistant', 'I could not complete that action. Please try again.'); }
      return true;
    },
  };
}
