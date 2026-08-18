import { renderFailure } from '../../core/failure-view.js';
import { setHtml } from '../../core/safe-dom.js';
import { approvalNotice, escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';

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

  function mailThreadListMarkup(
    threads,
    connected,
    emptyCopy = 'No messages matched that search.',
  ) {
    return threads.length
      ? `<div class="result-list mail-thread-list">${threads.map((thread, index) => `<button class="result ${index === 0 ? 'selected' : ''}" data-mail-thread="${thread.id}" data-mail-provider="${thread.accountId}"><span class="icon gmail">${icon('mail')}</span><span class="result-copy"><span class="result-title">${escapeHtml(thread.subject)}</span><span class="result-meta">${escapeHtml(thread.from || 'Unknown sender')} · ${escapeHtml(thread.label || connected.find((account) => account.id === thread.accountId)?.label || 'Mail')} · ${escapeHtml(thread.accountEmail || '')}</span></span><span class="chat-end"><time>${thread.timestamp ? new Date(thread.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''}</time>${thread.unread ? `<span class="unread-mail" title="Unread email" aria-label="Unread email">${icon('mail')}</span>` : ''}</span></button>`).join('')}</div>`
      : `<div class="clear-day"><span class="icon gmail">${icon('inbox')}</span><span><b>${escapeHtml(emptyCopy)}</b><small>Try a sender, subject, phrase, or a natural-language request.</small></span></div>`;
  }
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
    setHtml(inboxState.target, mailThreadListMarkup(threads, connected, 'Your inbox is empty.'));
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
        '<div class="loading-state"><span class="spinner"></span> Searching your connected inboxes…</div>',
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
        setHtml(state.target, mailThreadListMarkup(data.threads || [], state.connected));
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
  function showMailClient({ compose = false } = {}) {
    onOpen();
    clearTimeout(searchTimer);
    searchSequence += 1;
    inboxState = null;
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
      `<div class="result-header conversation-mode"><button class="back-button" id="back-mail">${icon('arrow-left')} Habibi</button><span class="verified">● checking accounts</span></div><div class="loading-state"><span class="spinner"></span> Checking connected mail accounts…</div>`,
    );
    document.querySelector('#back-mail').onclick = onHome;
    fetch('/api/mail/status')
      .then((response) => response.json())
      .then((data) => {
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
          `<div class="result-header conversation-mode"><button class="back-button" id="back-mail">${icon('arrow-left')} Habibi</button><span class="verified">● private mail client</span></div><section class="chat-client mail-client"><div class="chat-title"><span class="icon gmail">${icon('mail')}</span><span><b>Mail</b><small id="mail-status-copy">${escapeHtml(status)}</small></span><button class="history-button" id="manage-mail">Manage accounts</button></div><div class="messages mail-empty" id="mail-accounts"><div class="loading-state"><span class="spinner"></span> Loading your inbox…</div></div></section>`,
        );
        document.querySelector('#back-mail').onclick = onHome;
        document.querySelector('#manage-mail').onclick = showMailSettings;
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
            inboxState = { target, connected, threads, status };
            count.textContent = `${threads.length} messages`;
            const reconnectBanner = failed.length
              ? `<div class="link-warning mail-reconnect-banner">${failed.map((account) => `${escapeHtml(account.label)} · ${escapeHtml(account.email)} stopped working. <button type="button" class="link-button" data-mail-reconnect="${escapeHtml(account.id)}">Reconnect</button>`).join('<br>')}</div>`
              : '';
            if (!inboxState?.target?.isConnected) return;
            setHtml(target, reconnectBanner + mailThreadListMarkup(threads, connected));
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
          })
          .catch((error) => {
            renderFailure(target, error, {
              fallback: 'Could not load your inbox.',
              retry: () => showMailClient({ compose }),
            });
          });
      })
      .catch(() => {
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
