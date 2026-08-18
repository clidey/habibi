import { setHtml } from '../../core/safe-dom.js';
import { approvalNotice, escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';
import { createProactiveHome } from './proactive-home.js';

/** Owns EventKit transport, calendar views, and cached proactive home context. */
export function createCalendarFeature({
  defaultView,
  resultsView,
  count,
  notify,
  requestApproval,
  applyHomeLayout,
  onBack,
  onMailThread,
  demoMode = false,
  demoEvents = [],
  demoMail = [],
}) {
  function localDateTime(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function showEventDraft(existing) {
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(12, 30, 0, 0);
    const eventStart = existing ? new Date(existing.start) : start;
    const eventEnd = existing ? new Date(existing.end) : new Date(start.getTime() + 60 * 60 * 1000);
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = 'Calendar · draft';
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><b>Create event</b><span class="verified">● reviewed before save</span></div>
    <section class="event-draft"><div class="event-title"><span class="icon calendar">${icon('calendar-days')}</span><input id="event-title" value="${escapeHtml(existing ? existing.title : '')}" placeholder="Event title" aria-label="Event title" /></div><div class="event-field"><label>Starts</label><input id="event-start" type="datetime-local" value="${localDateTime(eventStart)}" /></div><div class="event-field"><label>Ends</label><input id="event-end" type="datetime-local" value="${localDateTime(eventEnd)}" /></div><div class="event-field"><label>Calendar</label><select id="event-calendar"><option>Loading calendars…</option></select></div><div class="event-note"><i data-lucide="shield-check"></i> ${existing ? approvalNotice('Saving these changes') : approvalNotice('Creating this event')}</div><div class="event-actions"><button class="secondary" id="cancel-event">Cancel</button><button class="primary" id="create-event">${existing ? 'Save changes' : 'Create event'} <kbd>⌘ ↵</kbd></button></div></section>`,
    );
    fetch('/api/calendars')
      .then((response) => response.json())
      .then((data) => {
        const select = document.querySelector('#event-calendar');
        if (!select) return;
        const names = data.ok && data.calendars.length ? data.calendars : ['Calendar'];
        setHtml(
          select,
          names
            .map(
              (name) =>
                `<option ${existing && name === existing.calendar ? 'selected' : ''}>${escapeHtml(name)}</option>`,
            )
            .join(''),
        );
      })
      .catch(() => {
        const select = document.querySelector('#event-calendar');
        if (select) setHtml(select, '<option>Calendar</option>');
      });
    document.querySelector('#cancel-event').onclick = onBack;
    document.querySelector('#create-event').onclick = async () => {
      const title = document.querySelector('#event-title').value.trim();
      const calendar = document.querySelector('#event-calendar').value;
      const startDate = new Date(document.querySelector('#event-start').value);
      const endDate = new Date(document.querySelector('#event-end').value);
      if (!title || Number.isNaN(startDate.valueOf()) || endDate <= startDate)
        return notify('Check the event details');
      const endpoint = existing ? '/api/calendar/event/update' : '/api/calendar/event';
      // The bound payload must mirror exactly what the route validates: create has
      // no id, update has one.
      const event = { title, calendar, start: startDate.toISOString(), end: endDate.toISOString() };
      if (existing) event.id = String(existing.id || '');
      let approvalToken;
      try {
        approvalToken = await requestApproval(
          existing ? 'calendar.update' : 'calendar.create',
          event,
        );
      } catch (error) {
        return notify(error.message);
      }
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...event, approvalToken }),
      });
      const result = await response.json();
      if (result.ok) {
        notify(existing ? `Updated “${title}”` : `Created “${title}”`);
        return onBack();
      }
      // A flat "permission or save failed" gives no way forward. Reuse the same
      // reason-coded copy loadCalendarEvents() already surfaces for reads, and
      // the same "Connect Calendar" affordance, when the failure looks
      // permission-related rather than a one-off AppleScript error.
      let reasonMessage = 'Calendar could not save this event. Try again.';
      let permissionReason = null;
      try {
        await loadCalendarEvents();
      } catch (permissionError) {
        reasonMessage = permissionError.message;
        permissionReason = permissionError.permissionReason;
      }
      const note = document.querySelector('.event-draft .event-note');
      if (note)
        setHtml(
          note,
          `<i data-lucide="shield-check"></i> ${escapeHtml(reasonMessage)}${permissionReason ? ' <button type="button" class="link-button" id="event-connect-calendar">Connect Calendar</button>' : ''}`,
        );
      document
        .querySelector('#event-connect-calendar')
        ?.addEventListener('click', requestCalendarAccess);
      refreshIcons();
      notify(reasonMessage);
    };
    refreshIcons();
  }
  function showUpcomingEvents({ onBack = onBack } = {}) {
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = 'Calendar · upcoming';
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-upcoming-events">${icon('arrow-left')} Habibi</button><span class="verified">● next 14 days</span></div><div class="agenda-list"><div class="loading-state"><span class="spinner"></span> Loading your calendar…</div></div>`,
    );
    document.querySelector('#back-upcoming-events').onclick = onBack;
    loadCalendarEvents()
      .then((data) => {
        const list = document.querySelector('.agenda-list');
        if (!list) return;
        if (!data.ok)
          return setHtml(
            list,
            '<div class="searching-local">Calendar access is needed to show upcoming events.</div>',
          );
        setHtml(
          list,
          data.events.length
            ? data.events
                .map(
                  (event) =>
                    `<button class="agenda-event" data-event="${encodeURIComponent(JSON.stringify(event))}"><span class="icon calendar">${icon('calendar-days')}</span><span><b>${escapeHtml(event.title || 'Untitled event')}</b><small>${escapeHtml(new Date(event.start).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} · ${escapeHtml(event.calendar)}</small></span><i data-lucide="chevron-right"></i></button>`,
                )
                .join('')
            : '<div class="searching-local">No events in the next 14 days.</div>',
        );
        list
          .querySelectorAll('.agenda-event')
          .forEach(
            (button) =>
              (button.onclick = () =>
                showEventDraft(JSON.parse(decodeURIComponent(button.dataset.event)))),
          );
        refreshIcons();
      })
      .catch(() => {
        const list = document.querySelector('.agenda-list');
        if (list)
          setHtml(list, '<div class="searching-local">Calendar is unavailable right now.</div>');
      });
  }

  function requestCalendarAccess() {
    const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
    if (!nativeBridge) {
      showUpcomingEvents();
      return;
    }
    const button = document.querySelector('#connect-calendar');
    if (button) {
      button.disabled = true;
      button.querySelector('small').textContent = 'Requesting Calendar access…';
    }
    window.__habibiNativeCalendarAccess = (result) => {
      window.__habibiNativeCalendarAccess = null;
      if (!result?.ok) {
        if (button) {
          button.disabled = false;
          button.querySelector('small').textContent =
            result?.reason === 'writeOnly' ? 'Allow Full Calendar access' : 'Allow Calendar access';
        }
        notify(result?.message || 'Calendar access was not granted.');
        return;
      }
      proactiveHome.load({ force: true });
    };
    nativeBridge.postMessage({ type: 'calendarAccess' });
  }

  function loadCalendarEvents() {
    const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
    // Habibi is the native app; a plain browser has no EventKit access at all.
    if (!nativeBridge) return Promise.reject(new Error('Calendar needs the Habibi app.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.__habibiNativeCalendarEvents = null;
        reject(new Error('Calendar did not respond.'));
      }, 10_000);
      window.__habibiNativeCalendarEvents = (payload) => {
        clearTimeout(timer);
        window.__habibiNativeCalendarEvents = null;
        if (payload?.ok) return resolve(payload);
        // A write-only grant is the common case and is recoverable, so name it
        // rather than reporting a generic failure the user cannot act on.
        const reasons = {
          writeOnly:
            'Habibi can only add events. Allow full calendar access in System Settings → Privacy & Security → Calendars.',
          denied:
            'Calendar access is turned off. Allow it in System Settings → Privacy & Security → Calendars.',
          notDetermined: 'Habibi has not been granted calendar access yet.',
        };
        const error = new Error(reasons[payload?.reason] || 'Calendar access is unavailable.');
        error.permissionReason = reasons[payload?.reason] ? payload.reason : null;
        reject(error);
      };
      nativeBridge.postMessage({ type: 'calendarEvents' });
    });
  }

  const proactiveHome = createProactiveHome({
    applyHomeLayout,
    onMailThread,
    demoMode,
    demoEvents,
    demoMail,
    showEventDraft,
    loadCalendarEvents,
    requestCalendarAccess,
  });
  return {
    hasContext: proactiveHome.hasContext,
    loadEvents: loadCalendarEvents,
    loadHome: proactiveHome.load,
    requestAccess: requestCalendarAccess,
    showDraft: showEventDraft,
    showUpcoming: showUpcomingEvents,
  };
}
