import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';

export function createProactiveHome({
  applyHomeLayout,
  onMailThread,
  demoMode,
  demoEvents,
  demoMail,
  showEventDraft,
  loadCalendarEvents,
  requestCalendarAccess,
}) {
  let proactiveContext = { events: [], mail: [], provider: '' };
  let proactiveLoadedAt = 0;
  let proactiveLoadInFlight = null;
  const proactiveCacheMs = 60_000;

  function renderProactiveEvents(events) {
    const glance = document.querySelector('#agenda-glance');
    if (!glance) return;
    const title = document.querySelector('#home-title');
    if (!events.length) {
      title.textContent = 'You’re clear for now';
      document.querySelector('#agenda-label').textContent = 'ALL CLEAR';
      setHtml(
        glance,
        '<div class="clear-day"><span class="icon calendar">' +
          icon('calendar-check') +
          '</span><span><b>No upcoming events in the next two weeks.</b><small>Use the command bar when you’re ready to plan something.</small></span></div>',
      );
    } else {
      const next = events[0];
      title.textContent = next.title || 'Your next event';
      document.querySelector('#agenda-label').textContent = 'UP NEXT';
      setHtml(
        glance,
        events
          .map((event, index) => {
            const start = new Date(event.start);
            const duration = Math.round((new Date(event.end) - start) / 60000);
            const allDay =
              duration >= 23 * 60 && start.getHours() === 0 && start.getMinutes() === 0;
            const when = allDay
              ? 'All day'
              : start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            const detail = allDay ? event.calendar : `${event.calendar} · ${duration} min`;
            return `<button class="glance-event ${index === 0 ? 'next' : ''}" data-event="${encodeURIComponent(JSON.stringify(event))}"><span class="glance-time">${escapeHtml(start.toLocaleDateString([], { weekday: 'short' }))}<b>${escapeHtml(when)}</b></span><span class="glance-copy"><b>${escapeHtml(event.title || 'Untitled event')}</b><small>${escapeHtml(detail)}</small></span><i data-lucide="chevron-right"></i></button>`;
          })
          .join(''),
      );
      glance
        .querySelectorAll('.glance-event')
        .forEach(
          (button) =>
            (button.onclick = () =>
              showEventDraft(JSON.parse(decodeURIComponent(button.dataset.event)))),
        );
    }
    applyHomeLayout();
    refreshIcons();
  }
  function renderProactiveBriefing() {
    const target = document.querySelector('#proactive-briefing');
    const mailTarget = document.querySelector('#proactive-mail');
    if (!target) return;
    const events = proactiveContext.events || [];
    const mail = proactiveContext.mail || [];
    const provider = proactiveContext.provider || '';
    const next = events[0];
    if (!mail.length && !next) {
      setHtml(target, '');
      if (mailTarget) setHtml(mailTarget, '');
      return;
    }
    const nextDetail = next
      ? `${next.title || 'An event'} · ${new Date(next.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : '';
    const summaryTitle =
      mail.length && next
        ? `${mail.length} recent email${mail.length === 1 ? '' : 's'} · next up`
        : mail.length
          ? `${mail.length} recent email${mail.length === 1 ? '' : 's'}`
          : 'Your next moment';
    const summaryDetail = nextDetail || 'Nothing new needs your attention.';
    const mailCards = mail
      .slice(0, 3)
      .map(
        (thread) =>
          `<button class="briefing-mail" data-proactive-mail="${thread.id}" data-proactive-provider="${escapeHtml(thread.accountId || provider)}"><span class="icon gmail">${icon('mail')}</span><span><b>${escapeHtml(thread.subject || '(No subject)')}</b><small>${escapeHtml(thread.from || 'Unknown sender')} · ${escapeHtml(thread.accountEmail || '')}</small></span><time>${new Date(thread.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></button>`,
      )
      .join('');
    setHtml(
      target,
      `<span class="briefing-heading">HABIBI BRIEFING</span><div class="briefing-summary"><span class="briefing-icon">${icon('sparkles')}</span><span class="briefing-copy"><b>${escapeHtml(summaryTitle)}</b><small>${escapeHtml(summaryDetail)}</small></span></div>`,
    );
    if (mailTarget) {
      setHtml(
        mailTarget,
        mailCards
          ? `<span class="briefing-heading">RECENT EMAIL</span><div class="proactive-mail-list">${mailCards}</div>`
          : '',
      );
      mailTarget
        .querySelectorAll('[data-proactive-mail]')
        .forEach(
          (button) =>
            (button.onclick = () =>
              onMailThread(button.dataset.proactiveMail, button.dataset.proactiveProvider)),
        );
    }
    applyHomeLayout();
    refreshIcons();
  }
  function loadProactiveHome({ force = false } = {}) {
    const glance = document.querySelector('#agenda-glance');
    if (!glance) return;
    if (demoMode) {
      proactiveContext = { events: demoEvents, mail: demoMail, provider: 'demo-mail' };
      document.querySelector('#home-date').textContent = 'TUESDAY, AUGUST 11';
      renderProactiveEvents(demoEvents);
      renderProactiveBriefing();
      return;
    }
    if (!force && proactiveLoadInFlight) return proactiveLoadInFlight;
    if (!force && proactiveLoadedAt && Date.now() - proactiveLoadedAt < proactiveCacheMs) {
      renderProactiveEvents(proactiveContext.events || []);
      renderProactiveBriefing();
      return Promise.resolve();
    }
    const now = new Date();
    proactiveContext = { events: [], mail: [], provider: '' };
    document.querySelector('#home-date').textContent = now
      .toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
      .toUpperCase();
    // A native EventKit/permission round-trip on first load can take a few
    // seconds; a plain spinner with no explanation reads as stuck rather than
    // normal, which is the exact pattern that caused a full debugging session
    // over what turned out to be an ordinary slow first launch.
    setHtml(
      glance,
      '<div class="loading-state"><span class="spinner"></span><span class="loading-copy">Checking your calendar…<small>Asking macOS for calendar access the first time can take a moment.</small></span></div>',
    );
    const briefing = document.querySelector('#proactive-briefing');
    if (briefing)
      setHtml(
        briefing,
        '<div class="loading-state"><span class="spinner"></span><span class="loading-copy">Checking recent context…<small>Reading calendar and mail locally before Habibi can summarize your day.</small></span></div>',
      );
    const calendarLoad = loadCalendarEvents()
      .then((data) => {
        if (!data.ok) throw new Error('Calendar unavailable');
        const events = data.events.slice(0, 4);
        proactiveContext.events = events;
        renderProactiveEvents(events);
        renderProactiveBriefing();
      })
      .catch(() => {
        document.querySelector('#home-title').textContent = 'Your day, privately';
        document.querySelector('#agenda-label').textContent = 'CALENDAR';
        setHtml(
          glance,
          '<button class="clear-day calendar-connect" id="connect-calendar"><span class="icon calendar">' +
            icon('calendar-clock') +
            '</span><span><b>Connect Calendar to see what’s next.</b><small>Allow Calendar access</small></span><i data-lucide="chevron-right"></i></button>',
        );
        document
          .querySelector('#connect-calendar')
          ?.addEventListener('click', requestCalendarAccess);
        applyHomeLayout();
        refreshIcons();
      });
    const mailLoad = fetch('/api/mail/status')
      .then((response) => response.json())
      .then((data) => {
        const accounts = (data.accounts || []).filter((item) => item.connected);
        if (!accounts.length) return;
        return fetch('/api/mail/recent?provider=all&hours=4')
          .then((response) => response.json())
          .then((recent) => {
            if (!recent.ok) return;
            proactiveContext.mail = recent.threads || [];
            proactiveContext.provider = 'all';
            renderProactiveBriefing();
          });
      })
      .catch(() => {});
    proactiveLoadInFlight = Promise.allSettled([calendarLoad, mailLoad]).finally(() => {
      proactiveLoadedAt = Date.now();
      proactiveLoadInFlight = null;
      if (!proactiveContext.events.length && !proactiveContext.mail.length)
        renderProactiveBriefing();
    });
    return proactiveLoadInFlight;
  }

  return {
    hasContext: () => Boolean(proactiveContext.events.length || proactiveContext.mail.length),
    load: loadProactiveHome,
  };
}
