import { assistantUtilities } from '../../data/assistant-utilities.js';
import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';

const labels = { home: 'Home', ask: 'Ask', whatsapp: 'WhatsApp', mail: 'Mail', calendar: 'Calendar', settings: 'Settings', whodb: 'WhoDB', emoji: 'Emoji', notes: 'Notes', clipboard: 'Clipboard', reminders: 'Reminders', focus: 'Focus', recents: 'Recent files' };

/** Persistent workspace navigation. Only observes route replacement and the small footer label. */
export function installWorkspaceNavigation({ input, defaultView, resultsView, count, home, aiChat, mail, calendar, settings, whatsappSetup, whodb, notes, daily, resetMode }) {
  const scope = document.querySelector('#search-scope');
  const strip = document.querySelector('#routing-strip');
  let current = 'home';
  const actions = { home: home.show, ask: () => aiChat.show(), mail: mail.showClient, calendar: calendar.showUpcoming, settings: settings.show, whatsapp: whatsappSetup.show, whodb: whodb.show, notes: () => notes.show(), ...Object.fromEntries(assistantUtilities.map(({id}) => [id, () => daily.show(id)])) };
  function go(workspace) {
    window.dispatchEvent(new Event('habibi-clear-launcher-mentions'));
    resetMode();
    input.value = '';
    current = workspace;
    actions[workspace]?.();
    sync();
    if (!['ask', 'notes'].includes(workspace)) input.focus({ preventScroll: true });
  }
  function sync() {
    const text = count.textContent.toLowerCase();
    let workspace = current;
    if (!defaultView.classList.contains('hidden')) workspace = 'home';
    else if (resultsView.querySelector('.best-matches-region')) workspace = 'search';
    else if (resultsView.querySelector('.habibi-chat')) workspace = 'ask';
    else if (resultsView.querySelector('.settings-view')) workspace = 'settings';
    else if (resultsView.querySelector('[data-daily-workspace]')) workspace = resultsView.querySelector('[data-daily-workspace]').dataset.dailyWorkspace;
    else if (resultsView.querySelector('.notes-workspace')) workspace = 'notes';
    else if (resultsView.querySelector('.emoji-workspace')) workspace = 'emoji';
    else if (resultsView.querySelector('.teleprompter-workspace')) workspace = 'teleprompter';
    else if (resultsView.querySelector('.kubernetes-client')) workspace = 'kubernetes';
    else if (resultsView.querySelector('.agent-sessions-plugin, .agent-transcript, .terminal-shell')) workspace = 'agents';
    else if (resultsView.querySelector('.skill-grid, .imported-skill-review')) workspace = 'skills';
    else if (resultsView.querySelector('.whodb-view')) workspace = 'whodb';
    else if (resultsView.querySelector('.mail-client, .mail-thread-client, .mail-onboarding') || text.startsWith('mail')) workspace = 'mail';
    else if (text.startsWith('calendar')) workspace = 'calendar';
    else if (text.startsWith('whatsapp') || resultsView.querySelector('.openwa-setup, .whatsapp-client')) workspace = 'whatsapp';
    current = workspace;
    document.body.dataset.workspace = workspace;
    document.querySelectorAll('[data-workspace-link]').forEach((button) => {
      const active = button.dataset.workspaceLink === (workspace === 'search' ? 'home' : workspace);
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    const scoped = ['mail', 'whatsapp', 'calendar', 'whodb', 'emoji', 'notes', 'clipboard', 'reminders', 'recents'].includes(workspace);
    scope.classList.toggle('hidden', !scoped);
    scope.querySelector('span').textContent = scoped ? `IN ${labels[workspace]}` : '';
    document.querySelector('#escape-hint').textContent = workspace === 'home' ? 'close' : workspace === 'search' ? 'clear' : 'back';
    if (workspace !== 'search') strip.classList.add('hidden');
    if (workspace === 'calendar') input.placeholder = 'Describe an event: “lunch with Sana Friday 1pm”';
    if (workspace === 'whatsapp') input.placeholder = 'Search WhatsApp chats…';
    if (workspace === 'mail') input.placeholder = 'Search mail…';
    if (workspace === 'notes') input.placeholder = 'Search notes, or press Enter to create one…';
    if (workspace === 'emoji') input.placeholder = 'Search emoji: fire, party, thanks…';
    if (workspace === 'settings' || workspace === 'ask' || (workspace === 'whodb' && !resultsView.querySelector('.whodb-connected'))) input.placeholder = 'Search anything, or ask Habibi…';
    if (workspace === 'whatsapp' && !resultsView.querySelector('.workspace-heading, .whatsapp-client')) {
      const header = document.createElement('div');
      header.className = 'workspace-heading';
      const status = resultsView.querySelector('.verified')?.textContent.replace(/^●\s*/, '') || 'Local service';
      setHtml(header, `<span><p class="eyebrow">HABIBI · WHATSAPP</p><h2>Chats</h2></span><span class="status-pill">${escapeHtml(status)}</span>`);
      resultsView.prepend(header);
      resultsView.querySelector('.conversation-mode')?.classList.add('hidden');
    }
    refreshIcons();
  }
  document.querySelectorAll('[data-workspace-link]').forEach((button) => { button.addEventListener('click', () => go(button.dataset.workspaceLink)); });
  scope.onclick = () => go('home');
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Backspace' || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || input.value.length || scope.classList.contains('hidden')) return;
    event.preventDefault();
    go('home');
  });
  new MutationObserver(sync).observe(resultsView, { childList: true });
  new MutationObserver(sync).observe(count, { childList: true, characterData: true, subtree: true });
  sync();
  return { go, sync };
}
