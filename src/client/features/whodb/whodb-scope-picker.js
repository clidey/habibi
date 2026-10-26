import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';

export function installWhoDbScopePicker({ trigger, host, state, onSelect }) {
  const popover = document.createElement('div');
  popover.className = 'whodb-scope-popover hidden';
  host.append(popover);
  let org = state.org;
  let projects = state.projects;
  let search = '';
  let sequence = 0;
  const outside = (event) => { if (!host.contains(event.target)) close(); };
  function close() { popover.classList.add('hidden'); trigger.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); }
  function render() {
    const visibleOrgs = state.orgs.filter((item) => item.name.toLowerCase().includes(search));
    setHtml(popover, `<div class="whodb-scope-search">${icon('search')}<input id="whodb-scope-search" placeholder="Find an org or project…" value="${escapeHtml(search)}" aria-label="Find an organization or project" /></div><div class="whodb-scope-columns"><div><p class="briefing-heading">ORGANIZATIONS</p>${visibleOrgs.map((item) => `<button data-pick-org="${escapeHtml(item.id)}" class="${item.id === org.id ? 'selected' : ''}"><span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.role || 'Organization')}</small></span>${icon('chevron-right')}</button>`).join('')}</div><div><p class="briefing-heading">PROJECTS IN ${escapeHtml(org.name)}</p><button data-pick-project="" class="${!state.project && org.id === state.org.id ? 'selected' : ''}"><span><b>All projects</b><small>${projects.length} projects</small></span>${!state.project && org.id === state.org.id ? icon('check') : ''}</button>${projects.filter((item) => item.name.toLowerCase().includes(search)).map((item) => `<button data-pick-project="${escapeHtml(item.id)}" class="${item.id === state.project ? 'selected' : ''}"><span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.description || '')}</small></span>${item.id === state.project ? icon('check') : ''}</button>`).join('')}</div></div>`);
    const field = popover.querySelector('input');
    field.oninput = () => { search = field.value.toLowerCase(); const position = field.selectionStart; render(); const next = popover.querySelector('input'); next.focus(); next.setSelectionRange(position, position); };
    popover.querySelectorAll('[data-pick-org]').forEach((button) => {
      button.onclick = async () => {
        const request = ++sequence;
        button.setAttribute('aria-busy', 'true');
        try {
          const data = await fetch(`/api/whodb/scope?org=${encodeURIComponent(button.dataset.pickOrg)}`).then((response) => response.json());
          if (request !== sequence || !popover.isConnected || popover.classList.contains('hidden')) return;
          if (!data.ok || !data.org) throw new Error();
          org = data.org; projects = data.projects; render(); popover.querySelector('input').focus();
        } catch { button.removeAttribute('aria-busy'); button.querySelector('small').textContent = 'Unavailable. Try again.'; }
      };
    });
    popover.querySelectorAll('[data-pick-project]').forEach((button) => { button.onclick = () => { close(); onSelect({ ...state, org, projects, project: button.dataset.pickProject }); }; });
    refreshIcons();
  }
  trigger.onclick = () => { const hidden = popover.classList.toggle('hidden'); trigger.setAttribute('aria-expanded', String(!hidden)); if (!hidden) { render(); popover.querySelector('input').focus(); document.addEventListener('pointerdown', outside, true); } else close(); };
  host.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !popover.classList.contains('hidden')) { event.preventDefault(); event.stopPropagation(); close(); trigger.focus(); } });
  host.addEventListener('focusout', (event) => { if (event.relatedTarget && !host.contains(event.relatedTarget)) close(); });
}
