import { escapeHtml, icon } from '../../core/view-helpers.js';
import { setHtml } from '../../core/safe-dom.js';
import { llmProviders } from './provider-catalog.js';

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
  const picker = resultsView.querySelector('#chat-model-picker');
  const menu = resultsView.querySelector('#chat-model-menu');
  const button = picker.querySelector('button');
  button.onclick = () => {
    const visible = menu.classList.toggle('hidden');
    button.setAttribute('aria-expanded', String(!visible));
    if (!visible) menu.querySelector('button')?.focus();
  };
  picker.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.classList.contains('hidden')) {
      event.preventDefault(); event.stopPropagation(); menu.classList.add('hidden'); button.setAttribute('aria-expanded', 'false'); button.focus();
    }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && !menu.classList.contains('hidden')) {
      event.preventDefault(); event.stopPropagation();
      const choices = [...menu.querySelectorAll('button')];
      const at = choices.indexOf(document.activeElement);
      choices[(at + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]?.focus();
    }
  });
  picker.addEventListener('focusout', (event) => {
    if (!picker.contains(event.relatedTarget)) { menu.classList.add('hidden'); button.setAttribute('aria-expanded', 'false'); }
  });
  return {
    update(state) {
      button.querySelector('span').textContent = state.configured ? `${llmProviders[state.provider]?.label || state.provider} · ${state.model}` : 'Choose a model';
      setHtml(menu, `<p>Model settings</p>${Object.entries(llmProviders).map(([id, provider]) => `<button type="button" class="${state.provider === id ? 'selected' : ''}" data-chat-provider="${id}"><span><b>${provider.label}</b><small>${state.provider === id ? escapeHtml(state.model || provider.model) : provider.description}</small></span><em>${state.provider === id ? 'ACTIVE' : provider.kind === 'local' ? 'LOCAL' : 'YOUR KEY'}</em></button>`).join('')}`);
      menu.querySelectorAll('[data-chat-provider]').forEach((choice) => { choice.onclick = () => openModelSetup({ provider: choice.dataset.chatProvider, afterConfigured: reopen }); });
    },
  };
}
