import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons, spinner } from '../../core/view-helpers.js';
import { whoDbResultMarkup } from './whodb-results-view.js';
import { installWhoDbScopePicker } from './whodb-scope-picker.js';

export function showWhoDbConnected({ input, resultsView, count, notify, connection, scope, onSettings }) {
  let state = { ...scope, project: '', tab: 'ask' };
  let generation = 0;
  let running = false;
  function selection() { return { org: state.org.id, project: state.project }; }
  function render() {
    const selected = state.projects.find((item) => item.id === state.project);
    const projectName = selected?.name || 'All projects';
    count.textContent = `WhoDB · ${state.org.name}`;
    input.value = '';
    input.placeholder = `Ask ${state.org.name}, or search entities and apps…`;
    setHtml(resultsView, `<section class="whodb-connected whodb-view"><div class="whodb-workspace-header"><div class="workspace-heading"><span class="whodb-workspace-identity"><img class="whodb-owl" src="/assets/whodb-logo.svg" alt="" /><span><p class="eyebrow">HABIBI · WHODB</p><h2>${escapeHtml(state.org.name)} <span>/ ${escapeHtml(projectName)}</span></h2></span></span><button class="status-pill" id="whodb-connection-settings">Connected · read-only</button></div><div class="whodb-workspace-toolbar"><div class="mail-filter-tabs"><button data-whodb-tab="ask" class="${state.tab === 'ask' ? 'selected' : ''}">Ask</button><button data-whodb-tab="apps" class="${state.tab === 'apps' ? 'selected' : ''}">Apps</button></div><div class="whodb-scope-host"><button class="whodb-scope-trigger" id="whodb-scope-trigger" aria-expanded="false">${icon('database')}<span>${escapeHtml(state.org.name)} <small>/ ${escapeHtml(projectName)}</small></span>${icon('chevron-down')}</button></div></div></div><div id="whodb-workspace-body" class="whodb-workspace-body"></div>${state.tab === 'ask' ? `<div class="whodb-ask-composer"><div class="whodb-composer-heading"><small>${icon('lock-keyhole')} READ-ONLY</small></div><div class="whodb-ask-row"><textarea id="whodb-question" rows="1" aria-label="Ask WhoDB" placeholder="Ask ${escapeHtml(state.org.name)}’s data, read-only…"></textarea><button class="primary" id="ask-whodb">Ask</button></div><p class="whodb-model-note">Uses your configured model to answer questions about your data. Results and metadata are sent to that model only when you ask.</p></div>` : ''}</section>`);
    const page = resultsView.querySelector('.whodb-connected');
    page.querySelector('#whodb-connection-settings').onclick = onSettings;
    page.querySelectorAll('[data-whodb-tab]').forEach((button) => { button.onclick = () => { if (running) return notify('Wait for the current question to finish.'); state.tab = button.dataset.whodbTab; render(); }; });
    installWhoDbScopePicker({ trigger: page.querySelector('#whodb-scope-trigger'), host: page.querySelector('.whodb-scope-host'), state, onSelect: (next) => { if (running) return notify('Wait for the current question to finish.'); state = next; render(); } });
    if (state.tab === 'apps') loadApps(page); else {
      welcome(page);
      page.querySelector('#ask-whodb').onclick = () => ask(page);
      page.querySelector('#whodb-question').onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); ask(page); } };
    }
    refreshIcons();
  }
  function welcome(page) {
    const prompts = ['Which orders shipped late this week?', 'Revenue by region this week', 'Top return reasons this month'];
    setHtml(page.querySelector('#whodb-workspace-body'), `<p class="whodb-workspace-intro">Ask in plain words. Habibi finds the relevant data, runs read-only tools, and shows what WhoDB returned.</p><div class="ask-suggestions">${prompts.map((prompt) => `<button data-whodb-prompt="${escapeHtml(prompt)}">${escapeHtml(prompt)}${icon('arrow-right')}</button>`).join('')}</div>`);
    page.querySelectorAll('[data-whodb-prompt]').forEach((button) => { button.onclick = () => { const field = page.querySelector('#whodb-question'); field.value = button.dataset.whodbPrompt; field.focus(); }; });
  }
  async function loadApps(page) {
    const target = page.querySelector('#whodb-workspace-body');
    setHtml(target, '<div class="loading-state">' + spinner() + ' Loading your apps…</div>');
    try {
      const data = await fetch(`/api/whodb/apps?${new URLSearchParams(selection())}`).then((response) => response.json());
      if (!page.isConnected) return;
      if (!data.ok) throw new Error();
      setHtml(target, `${data.partial ? '<p class="link-warning">Showing apps from the first 12 projects. Select a project to narrow the list.</p>' : ''}${data.apps.length ? `<div class="whodb-apps">${data.apps.map((app) => `<div class="whodb-app-row"><span class="icon">${icon('boxes')}</span><span><b>${escapeHtml(app.name)}</b><small>${escapeHtml(app.description)}</small></span><span class="briefing-heading">${escapeHtml(app.projectName)}</span><a class="secondary whodb-app-link" data-app-id="${escapeHtml(app.id)}">Open</a></div>`).join('')}</div>` : '<div class="clear-day"><span><b>No apps in this scope.</b><small>Choose another project or create an app in WhoDB.</small></span></div>'}`);
      target.querySelectorAll('[data-app-id]').forEach((link) => {
        const app = data.apps.find((item) => item.id === link.dataset.appId);
        try {
          const base = new URL(connection.host);
          const url = new URL(app.url || `/apps/${encodeURIComponent(app.id)}`, base);
          if (url.origin !== base.origin || !['https:', 'http:'].includes(url.protocol)) throw new Error();
          link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
        } catch { link.removeAttribute('href'); link.textContent = 'Set instance URL'; link.onclick = onSettings; }
      });
      refreshIcons();
    } catch { if (page.isConnected) setHtml(target, '<div class="clear-day">Apps could not load. Check your WhoDB connection and workspace permissions.</div>'); }
  }
  async function ask(page) {
    const field = page.querySelector('#whodb-question');
    const question = field.value.trim();
    if (!question || running) return;
    const request = ++generation;
    running = true;
    const button = page.querySelector('#ask-whodb');
    button.disabled = true; field.disabled = true;
    const body = page.querySelector('#whodb-workspace-body');
    setHtml(body, `<div class="whodb-user-question">${escapeHtml(question)}</div><div class="loading-state">${spinner()} Reading WhoDB…</div>`);
    const started = performance.now();
    try {
      const data = await fetch('/api/whodb/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...selection(), question, mode: 'data' }) }).then((response) => response.json());
      if (request !== generation || !page.isConnected) return;
      if (!data.ok) { setHtml(body, `<div class="clear-day">${escapeHtml(data.error || 'WhoDB could not answer. Try again.')}</div>`); return; }
      setHtml(body, `<div class="whodb-user-question">${escapeHtml(question)}</div>${whoDbResultMarkup(data)}<p class="whodb-result-timing">READ-ONLY · ${((performance.now() - started) / 1000).toFixed(1)}s</p>`);
      body.querySelector('#copy-whodb-results').onclick = () => copy(JSON.stringify(data.datasets, null, 2));
      body.querySelector('#copy-whodb-sql')?.addEventListener('click', () => copy(data.datasets.map((item) => item.sql).filter(Boolean).join('\n\n')));
      field.value = '';
      refreshIcons();
    } catch { if (page.isConnected) setHtml(body, '<div class="clear-day">WhoDB is unavailable. Check your connection and try again.</div>'); }
    finally { running = false; button.disabled = false; field.disabled = false; }
  }
  async function copy(text) { try { await navigator.clipboard.writeText(text); notify('Copied'); } catch { notify('Could not copy. Try again.'); } }
  function filter(query) {
    const needle = query.toLowerCase();
    resultsView.querySelectorAll('.whodb-app-row').forEach((row) => { row.hidden = !row.textContent.toLowerCase().includes(needle); });
    const draft = resultsView.querySelector('#whodb-question');
    if (draft && !draft.disabled) draft.value = query;
  }
  render();
  return { filter };
}
