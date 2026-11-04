import { escapeHtml, icon } from '../../core/view-helpers.js';
import { setHtml } from '../../core/safe-dom.js';
import { llmProviders } from '../../data/llm-providers.js';
import { refreshUxNativeSelect } from '../../ux/select-control.js';

export function askWelcomeMarkup() {
  return `<div class="ask-welcome" id="ask-welcome"><p class="eyebrow">HABIBI · ASK</p><h2>Ask anything.<br>Habibi finds the context.</h2><p>Find files, prepare messages, and plan your day. Habibi asks before taking action. History stays on this Mac.</p><div class="ask-suggestions">${['Summarize my unread mail', 'What does my week look like?'].map((text) => `<button type="button" data-ask-suggestion="${escapeHtml(text)}">${escapeHtml(text)}${icon('arrow-right')}</button>`).join('')}</div></div>`;
}

export function installAskView({ resultsView, openModelSetup, reopen }) {
  resultsView.querySelectorAll('[data-ask-suggestion]').forEach((button) => {
    button.onclick = () => {
      const draft = resultsView.querySelector('#habibi-draft');
      draft.value = button.dataset.askSuggestion;
      draft.focus();
    };
  });
  const picker = resultsView.querySelector('#chat-model-select');
  picker.onchange = () => {
    if (picker.value) openModelSetup({ provider: picker.value, afterConfigured: reopen });
  };
  return {
    update(state) {
      const current = state.configured ? `${llmProviders[state.provider]?.label || state.provider} · ${state.model}` : 'Choose a model';
      setHtml(picker, `<option value="">${escapeHtml(current)}</option>${Object.entries(llmProviders).map(([id, provider]) => `<option value="${id}">${escapeHtml(provider.label)} · ${escapeHtml(state.provider === id ? state.model || provider.model : provider.description)}</option>`).join('')}`);
      picker.value = '';
      refreshUxNativeSelect(picker);
    },
  };
}
