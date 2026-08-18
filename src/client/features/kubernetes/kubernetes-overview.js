import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';
import { loadingSkeleton } from '../../ui/loading-view.js';

export function createKubernetesOverview({ input, find, state, runQuery, showDetail }) {
  function renderScopePicker({
    triggerId,
    menuId,
    options,
    selected,
    label,
    dataAttribute,
    onSelect,
  }) {
    const trigger = find(`#${triggerId}`);
    const menu = find(`#${menuId}`);
    if (!trigger || !menu) return;
    setHtml(
      trigger,
      `<span>${escapeHtml(selected || (label === 'Namespace' ? 'All namespaces' : 'No context found'))}</span>${icon('chevrons-up-down')}`,
    );
    trigger.disabled = !options.length;
    setHtml(
      menu,
      options
        .map(
          (option) =>
            `<button type="button" role="option" aria-selected="${option.value === selected}" class="kubernetes-context-option ${option.value === selected ? 'selected' : ''}" ${dataAttribute}="${escapeHtml(option.value)}"><span>${escapeHtml(option.label)}</span>${option.value === selected ? icon('check') : ''}</button>`,
        )
        .join(''),
    );
    const close = (restoreFocus) => {
      menu.classList.add('hidden');
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus({ preventScroll: true });
    };
    const open = () => {
      menu.classList.remove('hidden');
      trigger.setAttribute('aria-expanded', 'true');
      const selectedOption = menu.querySelector('.selected') || menu.querySelector('button');
      selectedOption?.focus({ preventScroll: true });
    };
    trigger.onclick = () => (menu.classList.contains('hidden') ? open() : close(false));
    trigger.onkeydown = (event) => {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        open();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        close(false);
        input.focus({ preventScroll: true });
      }
    };
    menu.querySelectorAll(`[${dataAttribute}]`).forEach((button, index, buttons) => {
      button.onclick = () => {
        close(false);
        onSelect(button.getAttribute(dataAttribute) || '');
      };
      button.onkeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close(true);
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          button.click();
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          buttons[
            (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          ].focus({ preventScroll: true });
        }
      };
    });
    refreshIcons();
  }

  function renderScopePickers() {
    renderScopePicker({
      triggerId: 'kubernetes-context-trigger',
      menuId: 'kubernetes-context-menu',
      options: state.contexts.map((value) => ({ value, label: value })),
      selected: state.context,
      label: 'Context',
      dataAttribute: 'data-kubernetes-context',
      onSelect: (context) => loadOverview(context, ''),
    });
    renderScopePicker({
      triggerId: 'kubernetes-namespace-trigger',
      menuId: 'kubernetes-namespace-menu',
      options: [
        { value: '', label: 'All namespaces' },
        ...state.namespaces.map((value) => ({ value, label: value })),
      ],
      selected: state.namespace,
      label: 'Namespace',
      dataAttribute: 'data-kubernetes-namespace',
      onSelect: (namespace) => loadOverview(state.context, namespace),
    });
  }

  function renderOverview(data) {
    const output = find('#kubernetes-output');
    const trigger = find('#kubernetes-context-trigger');
    if (!output || !trigger) return;
    if (!data.ok) {
      setHtml(
        output,
        `<div class="local-files-empty">${escapeHtml(data.error || 'Could not load your Kubernetes contexts.')}</div>`,
      );
      trigger.disabled = true;
      return;
    }
    state = {
      context: data.context || '',
      contexts: data.contexts || [],
      namespace: data.namespace || '',
      namespaces: data.namespaces || [],
    };
    renderScopePickers();
    const titles = { pods: 'Pods', deployments: 'Deployments', services: 'Services' };
    const resourceCard = (resource) => {
      const items = resource.items || [];
      if (!resource.ok)
        return `<section class="kubernetes-resource"><header><b>${titles[resource.kind] || resource.kind}</b></header><small>${escapeHtml(resource.error || `Could not load ${resource.kind}.`)}</small></section>`;
      return `<section class="kubernetes-resource"><header><span><b>${titles[resource.kind] || resource.kind}</b><small>${items.length}${items.length === 80 ? '+' : ''} visible</small></span><button type="button" data-kubernetes-query="get ${resource.kind} -A">View all ${icon('arrow-up-right')}</button></header>${items.length ? `<div class="kubernetes-list">${items.map((item) => `<button class="kubernetes-item" data-kubernetes-detail="true" data-kubernetes-kind="${escapeHtml(resource.kind)}" data-kubernetes-name="${escapeHtml(item.name)}" data-kubernetes-namespace="${escapeHtml(item.namespace)}"><span class="kubernetes-resource-name"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.namespace)}</small></span><span class="kubernetes-resource-meta"><em>${escapeHtml(item.primary || '')}</em><small>${escapeHtml(item.secondary || '')}</small></span>${item.badge ? `<i>${escapeHtml(item.badge)}</i>` : ''}</button>`).join('')}</div>` : '<div class="kubernetes-empty">Nothing here in this context.</div>'}</section>`;
    };
    setHtml(
      output,
      `<div class="kubernetes-overview-head"><span><b>Cluster overview</b><small>${escapeHtml(data.context || 'No context selected')}</small></span><span>${(data.resources || []).reduce((total, resource) => total + (resource.items?.length || 0), 0)} resources</span></div>${(data.resources || []).map(resourceCard).join('')}`,
    );
    output.querySelectorAll('[data-kubernetes-query]').forEach(
      (button) =>
        (button.onclick = () => {
          input.value = button.dataset.kubernetesQuery;
          runQuery();
        }),
    );
    output
      .querySelectorAll('[data-kubernetes-detail]')
      .forEach(
        (button) =>
          (button.onclick = () =>
            showDetail(
              button.dataset.kubernetesKind,
              button.dataset.kubernetesName,
              button.dataset.kubernetesNamespace,
            )),
      );
    refreshIcons();
  }

  async function loadOverview(context = state.context, namespace = state.namespace) {
    const output = find('#kubernetes-output');
    if (!output) return;
    setHtml(
      output,
      loadingSkeleton(
        'Loading cluster overview',
        'Reading pods, deployments, and services in parallel.',
      ),
    );
    try {
      renderOverview(
        await fetch(
          `/api/kubernetes/overview?context=${encodeURIComponent(context)}&namespace=${encodeURIComponent(namespace)}`,
        ).then((response) => response.json()),
      );
    } catch (_) {
      renderOverview({ ok: false, error: 'Could not load your Kubernetes overview.' });
    }
  }

  return { load: loadOverview };
}
