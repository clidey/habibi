import { categorizeError } from '../../core/failure-view.js';
import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons, safeImageSrc } from '../../core/view-helpers.js';
import { createWhatsAppComponentLoader } from './component-loader.js';

const whatsappRiskDismissedKey = 'habibi.whatsapp.risk-disclosure-dismissed.v1';

/** Owns native WhatsApp component readiness, OpenWA setup, reconnect, and pairing state. */
export function createWhatsAppSetupFeature({ defaultView, resultsView, count, onChats, onHome }) {
  let stateKey = null;
  const componentLoader = createWhatsAppComponentLoader();

  function showChatClient({ onBack = onHome } = {}) {
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = 'WhatsApp · local service';
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-whatsapp-client">${icon('arrow-left')} Habibi</button><span class="verified">● preparing WhatsApp</span></div><div class="loading-state"><span class="spinner"></span> <span id="whatsapp-component-copy">Checking the private WhatsApp component…</span></div>`,
    );
    document.querySelector('#back-whatsapp-client').onclick = onBack;
    // Chromium's own verify/cold-start can take a while on first run, same
    // reasoning as the connect-wait escalation below — a static line for that
    // long reads as stuck, not slow.
    const setComponentCopy = (text) => {
      const line = document.querySelector('#whatsapp-component-copy');
      if (line) line.textContent = text;
    };
    const slowComponent = setTimeout(
      () => setComponentCopy('Still checking — first-time setup can take a bit longer…'),
      6_000,
    );
    const verySlowComponent = setTimeout(
      () =>
        setComponentCopy(
          'Still working on it. This is unusually long, but WhatsApp setup is worth the wait — hang tight.',
        ),
      20_000,
    );
    componentLoader
      .ensure()
      .then(() => {
        clearTimeout(slowComponent);
        clearTimeout(verySlowComponent);
        return fetch('/api/openwa/status');
      })
      .then((response) => response.json())
      .then((status) => {
        if (status.ok && status.session?.status === 'ready') return onChats();
        if (status.ok && !status.session) {
          // Render the real setup screen immediately instead of a separate
          // "starting your session" screen first — one less jarring full-screen
          // reset for what is conceptually a single continuous wait.
          showOpenWASetup({ ok: true, session: null, qrCode: null });
          const setStartingCopy = (text) => {
            const line = document.querySelector('#openwa-copy');
            if (line) line.textContent = text;
          };
          // Chromium can take 10–20 seconds on first launch, so escalate the waiting copy.
          const slow = setTimeout(
            () => setStartingCopy('Still starting — the first launch can take a bit longer…'),
            6_000,
          );
          const verySlow = setTimeout(
            () =>
              setStartingCopy(
                'Still working on it. This is unusually long, but WhatsApp setup is worth the wait — hang tight.',
              ),
            20_000,
          );
          return fetch('/api/openwa/connect', { method: 'POST' })
            .then((response) => response.json())
            .then((finalStatus) => {
              clearTimeout(slow);
              clearTimeout(verySlow);
              showOpenWASetup(finalStatus);
            });
        }
        showOpenWASetup(status);
      })
      .catch((error) => {
        clearTimeout(slowComponent);
        clearTimeout(verySlowComponent);
        setHtml(
          resultsView,
          `<div class="result-header conversation-mode"><button class="back-button" id="back-whatsapp-component">${icon('arrow-left')} Habibi</button><span class="verified">● component unavailable</span></div><div class="clear-day"><span class="icon whatsapp">${icon('message-circle-more')}</span><span><b>WhatsApp could not start.</b><small>${escapeHtml(categorizeError(error, 'The local WhatsApp component is unavailable.'))}</small></span><button class="secondary" id="retry-whatsapp-component">Try again</button></div>`,
        );
        document.querySelector('#back-whatsapp-component').onclick = onHome;
        document.querySelector('#retry-whatsapp-component').onclick = showChatClient;
        refreshIcons();
      });
  }

  function isReconnectingSession(status) {
    return Boolean(status.session?.phone) && !status.qrCode && status.session?.status !== 'ready';
  }
  function pollOpenWAReconnect() {
    setTimeout(() => {
      if (
        resultsView.classList.contains('hidden') ||
        !document.querySelector('#openwa-reconnect-view')
      )
        return;
      fetch('/api/openwa/status')
        .then((response) => response.json())
        .then(updateOpenWASetup)
        .catch(() => {});
    }, 1500);
  }
  function renderOpenWAReconnectView(status) {
    const name = status.session?.pushName;
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-whatsapp-setup">${icon('arrow-left')} Habibi</button><span class="verified">● reconnecting</span></div><div id="openwa-reconnect-view" class="loading-state"><span class="spinner"></span> <span>Reconnecting ${name ? `${escapeHtml(name)}’s` : 'your'} WhatsApp…</span></div>`,
    );
    document.querySelector('#back-whatsapp-setup').onclick = onHome;
    pollOpenWAReconnect();
  }
  const whatsappRiskDisclosure = () => {
    if (localStorage.getItem(whatsappRiskDismissedKey) === 'true') return '';
    return '<div class="risk-disclosure" id="openwa-risk-disclosure"><small>Uses WhatsApp Web, not Meta’s official API — very low but non-zero risk of account restriction.</small><button class="link-button" id="dismiss-openwa-risk">Got it</button></div>';
  };
  function showOpenWASetup(status) {
    if (
      document.querySelector('#openwa-dynamic') ||
      document.querySelector('#openwa-reconnect-view')
    )
      return updateOpenWASetup(status);
    if (isReconnectingSession(status)) return renderOpenWAReconnectView(status);
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-whatsapp-setup">${icon('arrow-left')} Habibi</button><span id="openwa-status" class="verified">● getting started</span></div><section class="openwa-setup"><div class="openwa-intro"><span class="icon whatsapp">${icon('message-circle-more')}</span><span><h2>Set up WhatsApp</h2><p id="openwa-copy">Preparing your local WhatsApp session…</p></span></div>${whatsappRiskDisclosure()}<ol class="setup-steps"><li id="openwa-step-session"><span>1</span><b>Start local session</b><small>Starting</small></li><li id="openwa-step-phone"><span>2</span><b>Link your phone</b><small>WhatsApp → Linked devices</small></li><li id="openwa-step-chat"><span>3</span><b>Start messaging</b><small>Search chats in Habibi</small></li></ol><div id="openwa-dynamic"></div></section>`,
    );
    document.querySelector('#back-whatsapp-setup').onclick = onHome;
    document.querySelector('#dismiss-openwa-risk')?.addEventListener('click', () => {
      localStorage.setItem(whatsappRiskDismissedKey, 'true');
      document.querySelector('#openwa-risk-disclosure')?.remove();
    });
    stateKey = null;
    updateOpenWASetup(status);
  }
  function updateOpenWASetup(status) {
    const ready = status.session?.status === 'ready';
    // The phone can finish linking after this view has rendered. Do not leave the
    // user on a completed setup screen (or require a refresh): enter the chat list
    // as soon as OpenWA confirms readiness.
    if (ready) return onChats();
    if (document.querySelector('#openwa-reconnect-view')) {
      if (isReconnectingSession(status)) return pollOpenWAReconnect();
      // A real re-link is now needed, or the session went away — fall through
      // to the full setup screen instead of staying on the reconnect spinner.
      setHtml(resultsView, '');
    }
    if (!document.querySelector('#openwa-dynamic')) return showOpenWASetup(status);
    const linking = status.session?.status === 'authenticating';
    const connecting = linking && !status.qrCode;
    // OpenWA can retain the last phone metadata after WhatsApp has rejected the
    // pairing. A qr_ready session with a previous connection is a retry state, not a
    // successful connection.
    const linkWasNotKept =
      status.session?.status === 'qr_ready' && Boolean(status.session?.connectedAt);
    const localStarted = Boolean(
      status.session && ['qr_ready', 'authenticating', 'ready'].includes(status.session.status),
    );
    const copy = ready
      ? 'Your chats are ready to use in Habibi.'
      : linkWasNotKept
        ? 'WhatsApp did not keep the previous device link. Scan this fresh code to try again.'
        : status.qrCode
          ? 'On your phone: WhatsApp → Settings → Linked devices → Link a device.'
          : connecting
            ? 'Connecting your phone now — keep WhatsApp open for a moment.'
            : 'Habibi is preparing your private WhatsApp connection.';
    const sessionRunning = Boolean(status.session);
    document.querySelector('#openwa-status').textContent = ready
      ? '● connected'
      : linkWasNotKept
        ? '● link needs retry'
        : connecting
          ? '● connecting'
          : '● getting started';
    document.querySelector('#openwa-copy').textContent = status.ok
      ? copy
      : 'OpenWA is not running locally.';
    const setStep = (id, state, label) => {
      const step = document.querySelector(id);
      step.className = state;
      step.querySelector('small').textContent = label;
    };
    setStep(
      '#openwa-step-session',
      localStarted ? 'done' : sessionRunning ? 'active' : '',
      localStarted ? 'Ready' : sessionRunning ? 'Starting' : 'Starting',
    );
    setStep(
      '#openwa-step-phone',
      ready ? 'done' : status.qrCode || connecting ? 'active' : '',
      ready
        ? 'Linked'
        : linkWasNotKept
          ? 'Link was not kept'
          : status.qrCode
            ? 'Ready to scan'
            : connecting
              ? 'Connecting…'
              : 'WhatsApp → Linked devices',
    );
    setStep('#openwa-step-chat', ready ? 'done' : '', ready ? 'Ready' : 'Search chats in Habibi');
    const dynamic = document.querySelector('#openwa-dynamic');
    const nextStateKey = `${status.session?.status || 'none'}:${status.session?.connectedAt || ''}:${status.qrCode || ''}`;
    if (nextStateKey !== stateKey) {
      stateKey = nextStateKey;
      setHtml(
        dynamic,
        `${connecting ? '<div class="connection-pending"><span class="mini-spinner"></span><span><b>Connecting your phone…</b><small>This normally takes a few seconds.</small></span></div>' : ''}${linkWasNotKept ? '<div class="link-warning">The previous link was not accepted. Use the currently displayed QR code.</div>' : ''}${status.qrCode ? `<img class="openwa-qr" src="${safeImageSrc(status.qrCode)}" alt="Scan with WhatsApp to link this local session" />` : ''}<div class="openwa-actions">${ready ? '<button class="primary" id="show-chats">Open chats</button>' : '<button class="secondary" id="restart-openwa">Refresh pairing</button>'}</div>`,
      );
      document.querySelector('#restart-openwa')?.addEventListener('click', () => {
        const button = document.querySelector('#restart-openwa');
        button.disabled = true;
        button.textContent = 'Refreshing…';
        // A real last-resort: force-kill and recreate the session immediately,
        // rather than the automatic self-heal paths' throttled/staleness-gated
        // recovery. Only reachable from a screen the user already sees because
        // something looks stuck.
        fetch('/api/openwa/reset', { method: 'POST' })
          .then((response) => response.json())
          .then((status) => {
            stateKey = null;
            updateOpenWASetup(status);
          })
          .catch(() => {
            stateKey = null;
            updateOpenWASetup({ ok: false });
          });
      });
      document.querySelector('#show-chats')?.addEventListener('click', onChats);
    }
    refreshIcons();
    if (status.ok && status.session && !ready)
      setTimeout(() => {
        if (!resultsView.classList.contains('hidden') && document.querySelector('#openwa-dynamic'))
          fetch('/api/openwa/status')
            .then((response) => response.json())
            .then(updateOpenWASetup)
            .catch(() => {});
      }, 1500);
  }

  return { show: showChatClient };
}
