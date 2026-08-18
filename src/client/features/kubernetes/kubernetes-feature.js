import { categorizeError, renderFailure } from '../../core/failure-view.js';
import { renderAssistantMarkdown } from '../../core/query.js';
import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';
import { loadingSkeleton } from '../../ui/loading-view.js';

const resourceKinds = [
  ['pods', 'Pods'], ['deployments', 'Deployments'], ['services', 'Services'], ['events', 'Events'],
  ['statefulsets', 'StatefulSets'], ['daemonsets', 'DaemonSets'], ['replicasets', 'ReplicaSets'],
  ['jobs', 'Jobs'], ['cronjobs', 'CronJobs'], ['ingresses', 'Ingresses'], ['configmaps', 'ConfigMaps'],
  ['secrets', 'Secrets'], ['namespaces', 'Namespaces'], ['nodes', 'Nodes'],
];

/** Creates the Kubernetes workspace controller and keeps its transient state private. */
export function createKubernetesFeature({ input, defaultView, resultsView, count, onBack, onOpen }) {
  let state = { context:'', contexts:[], namespace:'', namespaces:[] };
  let logFollowTimer = null;
  let logLines = [];
  const find = selector => resultsView.querySelector(selector);

  function stop() {
    if (!logFollowTimer) return;
    clearInterval(logFollowTimer);
    logFollowTimer = null;
  }

  function renderScopePicker({ triggerId, menuId, options, selected, label, dataAttribute, onSelect }) {
    const trigger = find(`#${triggerId}`); const menu = find(`#${menuId}`);
    if (!trigger || !menu) return;
    setHtml(trigger, `<span>${escapeHtml(selected || (label === 'Namespace' ? 'All namespaces' : 'No context found'))}</span>${icon('chevrons-up-down')}`);
    trigger.disabled = !options.length;
    setHtml(menu, options.map(option => `<button type="button" role="option" aria-selected="${option.value === selected}" class="kubernetes-context-option ${option.value === selected ? 'selected' : ''}" ${dataAttribute}="${escapeHtml(option.value)}"><span>${escapeHtml(option.label)}</span>${option.value === selected ? icon('check') : ''}</button>`).join(''));
    const close = restoreFocus => { menu.classList.add('hidden'); trigger.setAttribute('aria-expanded', 'false'); if (restoreFocus) trigger.focus({ preventScroll:true }); };
    const open = () => { menu.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true'); const selectedOption = menu.querySelector('.selected') || menu.querySelector('button'); selectedOption?.focus({ preventScroll:true }); };
    trigger.onclick = () => menu.classList.contains('hidden') ? open() : close(false);
    trigger.onkeydown = event => { if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); } if (event.key === 'Escape') { event.preventDefault(); close(false); input.focus({ preventScroll:true }); } };
    menu.querySelectorAll(`[${dataAttribute}]`).forEach((button, index, buttons) => {
      button.onclick = () => { close(false); onSelect(button.getAttribute(dataAttribute) || ''); };
      button.onkeydown = event => {
        if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); button.click(); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus({ preventScroll:true }); }
      };
    });
    refreshIcons();
  }

  function renderScopePickers() {
    renderScopePicker({ triggerId:'kubernetes-context-trigger', menuId:'kubernetes-context-menu', options:state.contexts.map(value => ({ value, label:value })), selected:state.context, label:'Context', dataAttribute:'data-kubernetes-context', onSelect:context => loadOverview(context, '') });
    renderScopePicker({ triggerId:'kubernetes-namespace-trigger', menuId:'kubernetes-namespace-menu', options:[{ value:'', label:'All namespaces' }, ...state.namespaces.map(value => ({ value, label:value }))], selected:state.namespace, label:'Namespace', dataAttribute:'data-kubernetes-namespace', onSelect:namespace => loadOverview(state.context, namespace) });
  }

  function renderOverview(data) {
    const output = find('#kubernetes-output'); const trigger = find('#kubernetes-context-trigger');
    if (!output || !trigger) return;
    if (!data.ok) { setHtml(output, `<div class="local-files-empty">${escapeHtml(data.error || 'Could not load your Kubernetes contexts.')}</div>`); trigger.disabled = true; return; }
    state = { context:data.context || '', contexts:data.contexts || [], namespace:data.namespace || '', namespaces:data.namespaces || [] };
    renderScopePickers();
    const titles = { pods:'Pods', deployments:'Deployments', services:'Services' };
    const resourceCard = resource => {
      const items = resource.items || [];
      if (!resource.ok) return `<section class="kubernetes-resource"><header><b>${titles[resource.kind] || resource.kind}</b></header><small>${escapeHtml(resource.error || `Could not load ${resource.kind}.`)}</small></section>`;
      return `<section class="kubernetes-resource"><header><span><b>${titles[resource.kind] || resource.kind}</b><small>${items.length}${items.length === 80 ? '+' : ''} visible</small></span><button type="button" data-kubernetes-query="get ${resource.kind} -A">View all ${icon('arrow-up-right')}</button></header>${items.length ? `<div class="kubernetes-list">${items.map(item => `<button class="kubernetes-item" data-kubernetes-detail="true" data-kubernetes-kind="${escapeHtml(resource.kind)}" data-kubernetes-name="${escapeHtml(item.name)}" data-kubernetes-namespace="${escapeHtml(item.namespace)}"><span class="kubernetes-resource-name"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.namespace)}</small></span><span class="kubernetes-resource-meta"><em>${escapeHtml(item.primary || '')}</em><small>${escapeHtml(item.secondary || '')}</small></span>${item.badge ? `<i>${escapeHtml(item.badge)}</i>` : ''}</button>`).join('')}</div>` : '<div class="kubernetes-empty">Nothing here in this context.</div>'}</section>`;
    };
    setHtml(output, `<div class="kubernetes-overview-head"><span><b>Cluster overview</b><small>${escapeHtml(data.context || 'No context selected')}</small></span><span>${(data.resources || []).reduce((total, resource) => total + (resource.items?.length || 0), 0)} resources</span></div>${(data.resources || []).map(resourceCard).join('')}`);
    output.querySelectorAll('[data-kubernetes-query]').forEach(button => button.onclick = () => { input.value = button.dataset.kubernetesQuery; runQuery(); });
    output.querySelectorAll('[data-kubernetes-detail]').forEach(button => button.onclick = () => showDetail(button.dataset.kubernetesKind, button.dataset.kubernetesName, button.dataset.kubernetesNamespace));
    refreshIcons();
  }

  async function loadOverview(context = state.context, namespace = state.namespace) {
    const output = find('#kubernetes-output'); if (!output) return;
    setHtml(output, loadingSkeleton('Loading cluster overview', 'Reading pods, deployments, and services in parallel.'));
    try { renderOverview(await fetch(`/api/kubernetes/overview?context=${encodeURIComponent(context)}&namespace=${encodeURIComponent(namespace)}`).then(response => response.json())); }
    catch (_) { renderOverview({ ok:false, error:'Could not load your Kubernetes overview.' }); }
  }

  async function runQuery() {
    const query = input.value.trim(); const output = find('#kubernetes-output');
    if (!output) return;
    if (!query) { setHtml(output, '<div class="local-files-empty">Try: get pods -A, describe deployment api -n production, logs api-7c9d -n production, or events -A.</div>'); return; }
    const direct = /^(?:kubectl\s+)?(?:get|describe|logs|events)\b/i.test(query);
    setHtml(output, loadingSkeleton(direct ? 'Planning a Kubernetes query' : 'Investigating Kubernetes', direct ? 'Habibi will only run safe kubectl reads.' : 'Inspecting relevant resources and bounded logs locally.'));
    try {
      const response = await fetch(direct ? '/api/kubernetes/query' : '/api/kubernetes/diagnose', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ query, context:state.context, namespace:state.namespace }) });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || 'kubectl could not complete that query.');
      if (!direct) {
        setHtml(output, `<div class="kubernetes-diagnosis"><header><span>${icon('sparkles')} Diagnosis</span><small>${escapeHtml(result.target ? `${result.target.kind}/${result.target.name}${result.target.namespace ? ` · ${result.target.namespace}` : ''}` : 'No target')}</small></header><article>${renderAssistantMarkdown(result.summary || 'No diagnosis was produced.')}</article><section class="kubernetes-tool-trace">${(result.trace || []).map(step => `<div><b>${escapeHtml(step.tool)}</b><small>${escapeHtml(step.detail)}</small></div>`).join('')}</section>${result.logs ? `<details><summary>Latest log tail</summary><pre>${escapeHtml(result.logs)}</pre></details>` : ''}</div>`);
        count.textContent = 'Kubernetes · diagnosis';
      } else { setHtml(output, `<div class="kubernetes-query-result"><pre>${escapeHtml(result.output || 'No resources found.')}</pre></div>`); count.textContent = `Kubernetes · ${result.action}`; }
    } catch (error) { renderFailure(output, error, { fallback:'Could not run kubectl.', retry:runQuery }); }
  }

  async function showDetail(kind, name, namespace) {
    stop();
    const output = find('#kubernetes-output'); if (!output) return;
    setHtml(output, loadingSkeleton('Reading resource details', 'Fetching the selected resource and its safe metadata.'));
    try {
      const response = await fetch('/api/kubernetes/detail', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ kind, name, namespace, context:state.context }) });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || 'Could not inspect this resource.');
      const detail = result.detail;
      const logsAction = detail.kind === 'pods' ? `<button type="button" class="kubernetes-log-button" id="kubernetes-open-logs">${icon('scroll-text')} Logs</button>` : '';
      const relatedPods = detail.relatedPods?.length ? `<section class="kubernetes-detail-section"><h3>Related pods</h3><div class="kubernetes-list">${detail.relatedPods.map(pod => `<button class="kubernetes-item" data-related-pod="true" data-kubernetes-name="${escapeHtml(pod.name)}" data-kubernetes-namespace="${escapeHtml(pod.namespace)}"><span class="kubernetes-resource-name"><b>${escapeHtml(pod.name)}</b><small>${escapeHtml(pod.namespace)}</small></span><span class="kubernetes-resource-meta"><em>${escapeHtml(pod.primary)}</em><small>${escapeHtml(pod.secondary)}</small></span><i>Logs</i></button>`).join('')}</div></section>` : '';
      setHtml(output, `<div class="kubernetes-detail"><button type="button" class="kubernetes-detail-back" id="kubernetes-detail-back">${icon('arrow-left')} Cluster overview</button><header><span><small>${escapeHtml(detail.kind)}</small><b>${escapeHtml(detail.name)}</b><em>${escapeHtml(detail.namespace || 'cluster scoped')}</em></span><span class="kubernetes-detail-actions">${logsAction}<i>${icon('boxes')}</i></span></header><section class="kubernetes-facts">${detail.facts.map(([label, value]) => `<div><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></div>`).join('')}</section>${detail.containers?.length ? `<section class="kubernetes-detail-section"><h3>Containers</h3>${detail.containers.map(container => `<div class="kubernetes-container"><span><b>${escapeHtml(container.name)}</b><small>${escapeHtml(container.image)}</small></span><span><em class="${container.ready ? 'ready' : ''}">${escapeHtml(container.state)}</em><small>${container.restarts} restart${container.restarts === 1 ? '' : 's'}</small></span></div>`).join('')}</section>` : ''}${relatedPods}${detail.conditions?.length ? `<section class="kubernetes-detail-section"><h3>Conditions</h3>${detail.conditions.map(condition => `<div class="kubernetes-condition"><span><b>${escapeHtml(condition.type)}</b><small>${escapeHtml(condition.reason || condition.message || 'No additional detail')}</small></span><em class="${condition.status === 'True' ? 'ready' : ''}">${escapeHtml(condition.status)}</em></div>`).join('')}</section>` : ''}${detail.labels?.length ? `<section class="kubernetes-detail-section"><h3>Labels</h3><div class="kubernetes-labels">${detail.labels.map(label => `<span><b>${escapeHtml(label.key)}</b>${escapeHtml(label.value)}</span>`).join('')}</div></section>` : ''}</div>`);
      find('#kubernetes-detail-back').onclick = () => loadOverview();
      find('#kubernetes-open-logs')?.addEventListener('click', () => showLogs(detail.name, detail.namespace));
      output.querySelectorAll('[data-related-pod]').forEach(button => button.onclick = () => showLogs(button.dataset.kubernetesName, button.dataset.kubernetesNamespace));
      refreshIcons();
    } catch (error) { renderFailure(output, error, { fallback:'Could not inspect this resource.', retry:() => showDetail(kind, name, namespace) }); }
  }

  async function showResourceList(kind) {
    stop();
    const output = find('#kubernetes-output'); if (!output) return;
    setHtml(output, loadingSkeleton('Loading resources', 'Fetching a compact, readable list.'));
    try {
      const response = await fetch('/api/kubernetes/resources', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ kind, context:state.context, namespace:state.namespace }) });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || 'Could not load these resources.');
      const label = String(result.kind || kind).replace(/\b\w/g, letter => letter.toUpperCase());
      setHtml(output, `<div class="kubernetes-subpage"><header><button type="button" class="kubernetes-detail-back" id="kubernetes-list-back">${icon('arrow-left')} Cluster overview</button><span><b>${escapeHtml(label)}</b><small>${result.items.length} visible in this context</small></span></header><div class="kubernetes-list">${result.items.map(item => `<button class="kubernetes-item" data-kubernetes-detail="true" data-kubernetes-kind="${escapeHtml(result.kind)}" data-kubernetes-name="${escapeHtml(item.name)}" data-kubernetes-namespace="${escapeHtml(item.namespace)}"><span class="kubernetes-resource-name"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.namespace)}</small></span><span class="kubernetes-resource-meta"><em>${escapeHtml(item.primary || '')}</em><small>${escapeHtml(item.secondary || '')}</small></span>${item.badge ? `<i>${escapeHtml(item.badge)}</i>` : ''}</button>`).join('') || '<div class="kubernetes-empty">Nothing here in this context.</div>'}</div></div>`);
      find('#kubernetes-list-back').onclick = () => loadOverview();
      output.querySelectorAll('[data-kubernetes-detail]').forEach(button => button.onclick = () => showDetail(button.dataset.kubernetesKind, button.dataset.kubernetesName, button.dataset.kubernetesNamespace));
      refreshIcons();
    } catch (error) { renderFailure(output, error, { fallback:'Could not load these resources.', retry:() => showResourceList(kind) }); }
  }

  function renderLogOutput({ stickToBottom = false } = {}) {
    const output = find('#kubernetes-log-output'); const filter = find('#kubernetes-log-filter'); const lineCount = find('#kubernetes-log-count');
    if (!output) return;
    const query = String(filter?.value || '').trim().toLowerCase();
    const visibleLines = query ? logLines.filter(line => line.toLowerCase().includes(query)) : logLines;
    setHtml(output, escapeHtml(visibleLines.join('\n') || (query ? 'No matching log lines.' : 'No log lines returned.')));
    if (lineCount) lineCount.textContent = query ? `${visibleLines.length}/${logLines.length} lines` : `${logLines.length} lines`;
    if (stickToBottom && !query) output.scrollTop = output.scrollHeight;
  }

  async function showLogs(pod, namespace) {
    stop(); logLines = [];
    const output = find('#kubernetes-output'); if (!output) return;
    const read = async () => {
      const response = await fetch('/api/kubernetes/logs', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ pod, namespace, context:state.context }) });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || 'Could not read pod logs.');
      logLines = String(result.output || '').split('\n').filter((line, index, lines) => line || index < lines.length - 1);
      renderLogOutput({ stickToBottom:true });
      return result;
    };
    setHtml(output, `<div class="kubernetes-log-page"><header><button type="button" class="kubernetes-detail-back" id="kubernetes-logs-back">${icon('arrow-left')} Resource details</button><span><small>Pod logs</small><b>${escapeHtml(pod)}</b><em>${escapeHtml(namespace)}</em></span><button type="button" class="kubernetes-log-button" id="kubernetes-follow-logs">${icon('radio')} Follow</button></header><div class="kubernetes-log-filter-row"><span>${icon('search')}</span><input id="kubernetes-log-filter" type="search" autocomplete="off" placeholder="Filter these log lines…" aria-label="Filter pod logs" /><small id="kubernetes-log-count">Loading…</small></div><pre id="kubernetes-log-output" class="kubernetes-log-output"><span class="spinner"></span> Reading logs…</pre></div>`);
    find('#kubernetes-logs-back').onclick = () => showDetail('pods', pod, namespace);
    find('#kubernetes-log-filter').oninput = () => renderLogOutput();
    const follow = find('#kubernetes-follow-logs');
    follow.onclick = () => {
      if (logFollowTimer) { stop(); follow.innerHTML = `${icon('radio')} Follow`; refreshIcons(); return; }
      follow.innerHTML = `${icon('pause')} Pause`; logFollowTimer = setInterval(() => read().catch(stop), 3000); refreshIcons();
    };
    try { await read(); } catch (error) { setHtml(find('#kubernetes-log-output'), escapeHtml(categorizeError(error, 'Could not read pod logs.'))); }
    refreshIcons();
  }

  function show(initialQuery = '') {
    stop(); onOpen();
    const query = String(initialQuery || '').trim();
    input.value = query.replace(/^(?:k8s|kubernetes)\s*/i, '');
    input.placeholder = 'Try: get pods -A · logs api-7c9d -n production';
    defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = 'Kubernetes';
    setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-kubernetes">${icon('arrow-left')} Habibi</button><span class="verified">● kubectl</span></div><section class="kubernetes-client"><div class="kubernetes-workspace-chrome"><div class="kubernetes-heading"><span class="kubernetes-mark">${icon('ship-wheel')}<span class="kubernetes-habibi-mark"><img src="/assets/logo.png" alt="Habibi" /></span></span><span><b>Kubernetes</b><small>Local cluster explorer · every query is audited on this Mac.</small></span></div><div class="kubernetes-toolbar"><div class="kubernetes-scopes"><div class="kubernetes-context"><span>Context</span><div class="kubernetes-context-picker"><button type="button" class="kubernetes-context-trigger" id="kubernetes-context-trigger" aria-haspopup="listbox" aria-expanded="false" disabled><span>Loading contexts…</span>${icon('chevrons-up-down')}</button><div class="kubernetes-context-menu hidden" id="kubernetes-context-menu" role="listbox" aria-label="Kubernetes context"></div></div></div><div class="kubernetes-context"><span>Namespace</span><div class="kubernetes-context-picker"><button type="button" class="kubernetes-context-trigger" id="kubernetes-namespace-trigger" aria-haspopup="listbox" aria-expanded="false" disabled><span>All namespaces</span>${icon('chevrons-up-down')}</button><div class="kubernetes-context-menu hidden" id="kubernetes-namespace-menu" role="listbox" aria-label="Kubernetes namespace"></div></div></div></div></div><div class="kubernetes-resource-rail" id="kubernetes-samples">${resourceKinds.map(([kind, label]) => `<button data-kubernetes-kind="${kind}" title="Browse ${label}">${escapeHtml(label)}</button>`).join('')}</div></div><div class="kubernetes-output" id="kubernetes-output">${loadingSkeleton('Loading cluster overview', 'Reading pods, deployments, and services in parallel.')}</div></section>`);
    find('#back-kubernetes').onclick = onBack;
    resultsView.querySelectorAll('[data-kubernetes-kind]').forEach(button => button.onclick = () => showResourceList(button.dataset.kubernetesKind));
    refreshIcons();
    requestAnimationFrame(() => input.focus({ preventScroll:true }));
    loadOverview();
    if (input.value.trim()) setTimeout(runQuery, 30);
  }

  return { show, runQuery, stop };
}
