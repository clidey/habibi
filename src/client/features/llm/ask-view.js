import { thisDevice } from '../../core/platform-copy.js';
import { escapeHtml, icon } from '../../core/view-helpers.js';
import { setHtml } from '../../core/safe-dom.js';
import { llmProviders } from '../../data/llm-providers.js';
import { assistantUtilities } from '../../data/assistant-utilities.js';
import { refreshUxNativeSelect } from '../../ux/select-control.js';

export function askWelcomeMarkup() {
  return `<div class="ask-welcome" id="ask-welcome"><p class="eyebrow">HABIBI · ASK</p><h2>Ask anything.<br>Habibi finds the context.</h2><p>Mention files with @, organize a folder, prepare messages, or set up a timer. Habibi asks before taking action. History stays on ${thisDevice()}.</p><div class="ask-suggestions">${['Organize a folder with @', 'Prepare a 25 minute focus timer'].map((text) => `<button type="button" data-ask-suggestion="${escapeHtml(text)}">${escapeHtml(text)}${icon('arrow-right')}</button>`).join('')}</div><div class="ask-utilities" role="group" aria-label="Habibi tools">${assistantUtilities.map(({ id, label, icon: glyph }) => `<button type="button" data-ask-utility="${id}">${icon(glyph)}${escapeHtml(label)}</button>`).join('')}</div></div>`;
}

export function installAskView({ resultsView, openModelSetup, reopen, onUtility }) {
  resultsView.querySelectorAll('[data-ask-utility]').forEach(button => {
    button.onclick = () => {
      const utility = assistantUtilities.find(item => item.id === button.dataset.askUtility);
      if (utility) onUtility(utility.request);
    };
  });
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
