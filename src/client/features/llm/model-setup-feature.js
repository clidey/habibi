import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';
import { llmProviders } from './provider-catalog.js';

/** Owns provider discovery, model selection, credential setup, and validation. */
export function createModelSetupFeature({ defaultView, resultsView, count, onBack, onChat, onOpen }) {
function show({ afterConfigured } = {}) {
  onOpen();
  defaultView.classList.add('hidden');
  resultsView.classList.remove('hidden');
  count.textContent = 'Set up Habibi';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-setup">${icon('arrow-left')} Habibi</button><span class="verified">● private by design</span></div><section class="provider-setup"><div class="chat-title"><span class="icon agents">${icon('sparkles')}</span><span><b>Connect a model</b><small>Pick a provider first—then we’ll only ask for what it needs.</small></span></div><div class="provider-options" role="radiogroup">${Object.entries(llmProviders).map(([id, provider]) => `<button class="provider-option" data-provider="${id}" role="radio" aria-checked="false"><span><b>${provider.label}</b><small>${provider.description}</small></span><em>${provider.kind === 'local' ? 'LOCAL' : 'YOUR KEY'}</em><i>${icon('chevron-right')}</i></button>`).join('')}</div><div id="provider-detail" aria-live="polite"></div></section>`);
  let selected = 'ollama';
  let activeConfiguration = null;
  let availableModels = [];
  let providerSelectionVersion = 0;
  const details = document.querySelector('#provider-detail');
  const select = providerId => {
    selected = providerId;
    const selectedProviderId = selected;
    const selectionVersion = ++providerSelectionVersion;
    // Model discovery is provider-scoped. Reset before painting the next
    // detail panel so switching from LM Studio cannot briefly show its local
    // models under a hosted provider (or vice versa).
    availableModels = [];
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
    setHtml(details, `<div class="provider-detail ${activeModel ? 'has-active-model' : ''}"><div class="provider-detail-title"><b>${provider.label}</b><span>${activeModel ? 'Currently active' : provider.kind === 'local' ? 'Runs locally on this Mac' : 'Uses your own API key'}</span></div><div class="provider-fields"><label><span class="provider-field-label">Model ${activeModel ? '<em class="active-model-label">Active</em>' : ''}</span><span class="model-combobox"><input id="llm-model" class="${activeModel ? 'active-model-input' : ''}" role="combobox" aria-expanded="false" aria-controls="llm-model-menu" value="${safeActiveModel || provider.model}" autocomplete="off" placeholder="Choose or type a model" /><button id="llm-model-trigger" type="button" aria-label="Show available models" aria-haspopup="listbox"><svg class="model-chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button><span id="llm-model-menu" class="model-menu hidden" role="listbox"></span></span></label>${provider.kind === 'local' ? `<label><span class="provider-field-label">Server address</span><input id="llm-endpoint" value="${provider.endpoint}" autocomplete="off" /></label>` : `<label><span class="provider-field-label">API key</span><input id="llm-api-key" type="password" autocomplete="off" placeholder="Leave blank to keep the current key" /></label>`}</div><div class="provider-actions"><span id="llm-setup-message">${activeModel ? `Currently using ${safeActiveModel}. Change it below to switch models.` : provider.kind === 'local' ? 'Looking for models on your local server…' : 'Your key is stored in macOS Keychain, never in Habibi.'}</span><button class="primary" id="save-llm">Continue <kbd>↵</kbd></button></div></div>`);
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
    let modelFetchTimer;
    const loadModels = async ({ useTypedKey = false } = {}) => {
      const apiKey = useTypedKey ? document.querySelector('#llm-api-key')?.value || '' : '';
      const response = await fetch('/api/llm/models', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ provider:selectedProviderId, endpoint, apiKey }) });
      const data = await response.json();
      // Ignore a response from a provider panel the user has already left.
      if (selectionVersion !== providerSelectionVersion || selectedProviderId !== selected || !modelInput.isConnected) return;
      if (data.models?.length) {
        availableModels = data.models;
        if (provider.kind === 'local' && modelInput.value === provider.model) modelInput.value = data.models[0];
        renderModels();
        document.querySelector('#llm-setup-message').textContent = `${data.models.length} available model${data.models.length === 1 ? '' : 's'} found — start typing to filter.`;
      } else if (provider.kind === 'local') document.querySelector('#llm-setup-message').textContent = 'No models found yet. Start the local server, or type a model name.';
      else document.querySelector('#llm-setup-message').textContent = 'Add or keep an API key to load available models, or type a model name.';
    };
    loadModels().catch(() => {});
    document.querySelector('#llm-api-key')?.addEventListener('input', () => {
      clearTimeout(modelFetchTimer);
      modelFetchTimer = setTimeout(() => loadModels({ useTypedKey:true }).catch(() => {}), 350);
    });
    document.querySelector('#save-llm').onclick = save;
  };
  document.querySelectorAll('.provider-option').forEach(option => option.onclick = () => select(option.dataset.provider));
  document.querySelector('#back-setup').onclick = onBack;
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
    if (afterConfigured) afterConfigured(); else onChat();
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

  return { show };
}

