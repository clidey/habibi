import { cacheSearchContext } from '../../core/search-context.js';
import { mailThreadListMarkup } from './mail-inbox-view.js';
import { renderFailure } from '../../core/failure-view.js';
import { setHtml } from '../../core/safe-dom.js';
import { approvalNotice, escapeHtml, icon, refreshIcons, spinner } from '../../core/view-helpers.js';

export function createMailInbox({
  input,
  defaultView,
  resultsView,
  count,
  onHome,
  onOpen,
  showMailThread,
  showMailProviderSetup,
  showMailSettings,
}) {
  let inboxState = null;
  let searchTimer = null;
  let searchSequence = 0;
  let providerFilter = 'all';
  const filtered = (threads) => threads.filter((thread) => providerFilter === 'all' || inboxState?.connected.find((account) => account.id === thread.accountId)?.provider === providerFilter);

  function bindMailThreads(target) {
    target
      .querySelectorAll('[data-mail-thread]')
      .forEach(
        (button) =>
          (button.onclick = () =>
            showMailThread(button.dataset.mailThread, button.dataset.mailProvider)),
      );
    refreshIcons();
  }
  function renderMailInbox(threads, connected) {
    if (!inboxState?.target?.isConnected) return;
    setHtml(inboxState.target, mailThreadListMarkup(filtered(threads), connected, 'Your inbox is empty.'));
    bindMailThreads(inboxState.target);
  }
  function searchMailInbox(query) {
    const state = inboxState;
    if (!state?.target?.isConnected) return;
    clearTimeout(searchTimer);
    const trimmed = query.trim();
    if (!trimmed) {
      document.querySelector('#mail-status-copy').textContent = state.status;
      count.textContent = `${state.threads.length} messages`;
      renderMailInbox(state.threads, state.connected);
      return;
    }
    const sequence = ++searchSequence;
    searchTimer = setTimeout(async () => {
      if (!inboxState?.target?.isConnected || sequence !== searchSequence) return;
      setHtml(
        state.target,
        '<div class="loading-state">' + spinner() + ' Searching your connected inboxes…</div>',
      );
      count.textContent = 'Searching mail…';
      try {
        const response = await fetch(
          `/api/mail/search?q=${encodeURIComponent(trimmed)}&provider=all`,
        );
        const data = await response.json();
        if (sequence !== searchSequence || !inboxState?.target?.isConnected) return;
        if (!data.ok) throw new Error(data.error || 'Could not search mail.');
        const plan = data.plan || {};
        const planner = plan.source === 'local-model' ? 'local model' : 'local matching';
        document.querySelector('#mail-status-copy').textContent = `Search results · ${planner}`;
        count.textContent = `${(data.threads || []).length} matching messages`;
        setHtml(state.target, mailThreadListMarkup(filtered(data.threads || []), state.connected));
        bindMailThreads(state.target);
      } catch (error) {
        if (sequence !== searchSequence || !inboxState?.target?.isConnected) return;
        renderFailure(state.target, error, {
          fallback: 'Could not search mail.',
          retry: () => searchMailInbox(trimmed),
        });
      }
    }, 260);
  }
  function showMailClient({ compose = false, query = '' } = {}) {
    onOpen();
    clearTimeout(searchTimer);
    searchSequence += 1;
    inboxState = null;
    providerFilter = 'all';
    input.value = '';
    input.placeholder = 'Search mail by sender, subject, or request…';
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = 'Mail · checking accounts…';
    // Decide onboarding vs. inbox before the first paint — a fully-wired
    // composer shell that gets replaced by onboarding a moment later (once
    // /api/mail/status resolves) is the same jarring reset WhatsApp had.
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-mail">${icon('arrow-left')} Habibi</button><span class="verified">● checking accounts</span></div><div class="loading-state">${spinner()} Checking connected mail accounts…</div>`,
    );
    document.querySelector('#back-mail').onclick = onHome;
    const routeMarker = resultsView.firstElementChild;
    fetch('/api/mail/status')
      .then((response) => response.json())
      .then((data) => {
        if (!routeMarker.isConnected) return;
        if (!data.ok) throw new Error('Mail unavailable');
        const providers = data.providers || [];
        const connected = (data.accounts || []).filter((account) => account.connected);
        if (!connected.length) {
          setHtml(
            resultsView,
            `<div class="result-header conversation-mode"><button class="back-button" id="back-mail">${icon('arrow-left')} Habibi</button><span class="verified">● private mail</span></div><section class="mail-onboarding"><div class="openwa-intro"><span class="icon gmail">${icon('mail')}</span><span><h2>Connect your mail</h2><p>Read threads and reply from Habibi. Your inbox stays with the provider; ${approvalNotice('sending')}</p></span></div><div class="provider-options mail-provider-options">${providers.map((provider) => `<button class="provider-option" data-mail-provider="${provider.id}"><span><b>${icon('mail')} ${provider.label}</b><small>${provider.configured ? 'Continue with your configured OAuth app' : 'Set up your OAuth app to connect'}</small></span><em>${provider.configured ? 'CONNECT' : 'SET UP'}</em><i>${icon('chevron-right')}</i></button>`).join('')}</div></section>`,
          );
          document.querySelector('#back-mail').onclick = onHome;
          resultsView
            .querySelectorAll('[data-mail-provider]')
            .forEach(
              (button) =>
                (button.onclick = () => showMailProviderSetup(button.dataset.mailProvider)),
            );
          refreshIcons();
          return;
        }
        const status = connected
          .map((account) => `${account.label} · ${account.email}`)
          .join(' + ');
        count.textContent = 'Mail · loading inbox…';
        setHtml(
          resultsView,
          `<div class="result-header conversation-mode"><button class="back-button" id="back-mail">${icon('arrow-left')} Habibi</button><span class="verified">● private mail client</span></div><div class="workspace-heading"><span><p class="eyebrow">HABIBI · MAIL</p><h2>Inbox</h2></span><span class="status-pill" id="mail-inbox-summary">${connected.length} accounts</span></div><section class="chat-client mail-client"><div class="chat-title hidden"><span class="icon gmail">${icon('mail')}</span><span><b>Mail</b><small id="mail-status-copy">${escapeHtml(status)}</small></span><button class="history-button" id="manage-mail">Manage accounts</button></div><div class="mail-filters"><div class="mail-filter-tabs"><button class="selected" data-mail-filter="all">All</button>${[...new Set(connected.map((account) => account.provider))].map((provider) => `<button data-mail-filter="${escapeHtml(provider)}">${escapeHtml(provider === 'gmail' ? 'Gmail' : provider === 'zoho' ? 'Zoho' : provider)}</button>`).join('')}</div><button class="link-button" id="mail-accounts-link">Accounts →</button></div><div class="messages mail-empty" id="mail-accounts"><div class="loading-state">${spinner()} Loading your inbox…</div></div></section>`,
        );
        document.querySelector('#back-mail').onclick = onHome;
        document.querySelector('#manage-mail').onclick = showMailSettings;
        document.querySelector('#mail-accounts-link').onclick = showMailSettings;
        resultsView.querySelectorAll('[data-mail-filter]').forEach((button) => { button.onclick = () => { providerFilter = button.dataset.mailFilter; resultsView.querySelectorAll('[data-mail-filter]').forEach((item) => item.classList.toggle('selected', item === button)); if (input.value.trim()) searchMailInbox(input.value); else if (inboxState) renderMailInbox(inboxState.threads, connected); }; });
        const target = document.querySelector('#mail-accounts');
        // Load each account independently: one account whose saved credentials
        // stopped working should not blank the whole inbox for accounts that are
        // still fine, and knowing exactly which account failed is what lets the
        // "Reconnect {email}" affordance below point at the right one.
        Promise.all(
          connected.map((account) =>
            fetch(`/api/mail/threads?provider=${encodeURIComponent(account.id)}`)
              .then((response) => response.json())
              .then((inbox) => ({ account, inbox }))
              .catch(() => ({ account, inbox: { ok: false } })),
          ),
        )
          .then((results) => {
            const threads = results
              .filter(({ inbox }) => inbox.ok)
              .flatMap(({ inbox }) => inbox.threads)
              .sort((a, b) => b.timestamp - a.timestamp);
            const failed = results.filter(({ inbox }) => !inbox.ok).map(({ account }) => account);
            if (!target.isConnected) return;
            inboxState = { target, connected, threads, status };
            cacheSearchContext('mail', threads.map((thread) => ({ title: thread.subject, meta: thread.from, icon: 'gmail', tag: 'MAIL', type: 'cached-mail', thread })));
            const summary = document.querySelector('#mail-inbox-summary');
            if (summary) summary.textContent = `${connected.length} accounts · ${threads.filter((thread) => thread.unread).length} unread`;
            count.textContent = `${threads.length} messages`;
            const reconnectBanner = failed.length
              ? `<div class="link-warning mail-reconnect-banner">${failed.map((account) => `${escapeHtml(account.label)} · ${escapeHtml(account.email)} stopped working. <button type="button" class="link-button" data-mail-reconnect="${escapeHtml(account.id)}">Reconnect</button>`).join('<br>')}</div>`
              : '';
            if (!inboxState?.target?.isConnected) return;
            setHtml(target, reconnectBanner + mailThreadListMarkup(filtered(threads), connected));
            bindMailThreads(target);
            target.querySelectorAll('[data-mail-reconnect]').forEach(
              (button) =>
                (button.onclick = () => {
                  const account = failed.find(
                    (candidate) => candidate.id === button.dataset.mailReconnect,
                  );
                  if (account) showMailProviderSetup(account.provider, account);
                }),
            );
            refreshIcons();
            if (query) { input.value = query; searchMailInbox(query); }
          })
          .catch((error) => {
            renderFailure(target, error, {
              fallback: 'Could not load your inbox.',
              retry: () => showMailClient({ compose }),
            });
          });
      })
      .catch(() => {
        if (!routeMarker.isConnected) return;
        setHtml(
          resultsView,
          `<div class="result-header conversation-mode"><button class="back-button" id="back-mail">${icon('arrow-left')} Habibi</button><span class="verified">● unavailable</span></div><div class="local-files-empty">Mail connection status is unavailable.</div>`,
        );
        document.querySelector('#back-mail').onclick = onHome;
      });
    refreshIcons();
  }
  return { getState: () => inboxState, search: searchMailInbox, show: showMailClient };
}
