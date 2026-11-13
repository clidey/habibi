import { primaryEnterLabel } from '../../core/primary-modifier.js';
import { calendarAgendaMarkup } from './calendar-view.js';
import { setHtml } from '../../core/safe-dom.js';
import { approvalNotice, escapeHtml, icon, refreshIcons, spinner } from '../../core/view-helpers.js';
import { createProactiveHome } from './proactive-home.js';
import { createCalendarAccounts } from './calendar-accounts.js';
import { createCalendarEventsLoader } from './calendar-native.js';

/** Owns calendar transport (EventKit and connected accounts), views, and cached home context. */
export function createCalendarFeature({
  defaultView,
  resultsView,
  count,
  notify,
  requestApproval,
  applyHomeLayout,
  onBack,
  onOpen = () => {},
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
    onOpen();
    const editing = Boolean(existing?.id);
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
      `<div class="result-header conversation-mode"><button class="back-button" id="back-event">${icon('arrow-left')} Calendar</button><span class="verified">Review event</span></div>
    <section class="event-draft" aria-labelledby="event-draft-heading">
      <div class="event-draft-heading"><span class="icon calendar">${icon('calendar-days')}</span><span><h2 id="event-draft-heading">${editing ? 'Edit event' : 'New event'}</h2><p>Review the details before saving.</p></span></div>
      <div class="event-fields">
        <div class="event-field event-title"><label for="event-title">Event title</label><input id="event-title" value="${escapeHtml(existing ? existing.title : '')}" placeholder="What’s happening?" /></div>
        <div class="event-field"><label for="event-start">Starts</label><input id="event-start" type="datetime-local" value="${localDateTime(eventStart)}" /></div>
        <div class="event-field"><label for="event-end">Ends</label><input id="event-end" type="datetime-local" value="${localDateTime(eventEnd)}" /></div>
        <div class="event-field event-calendar"><label for="event-calendar">Calendar</label><select id="event-calendar"><option>Loading calendars…</option></select></div>
      </div>
      <div class="event-draft-footer"><div class="event-note">${icon('shield-check')}<span>${editing ? approvalNotice('Saving these changes') : approvalNotice('Creating this event')}</span></div><div class="event-actions"><button class="secondary" id="cancel-event">Cancel</button><button class="primary" id="create-event">${editing ? 'Save changes' : 'Create event'} <kbd>${primaryEnterLabel()}</kbd></button></div></div>
    </section>`,
    );
    fetch('/api/calendars')
      .then((response) => response.json())
      .then((data) => {
        const select = document.querySelector('#event-calendar');
        if (!select) return;
        // Newer hosts send provider-qualified ids; older ones only names.
        const items = data.ok && data.items?.length
          ? data.items
          : (data.ok && data.calendars.length ? data.calendars : ['Calendar']).map((name) => ({ id: name, name, label: name }));
        const chosen = (item) => existing && (item.id === existing.calendarId || (!existing.calendarId && item.name === existing.calendar));
        setHtml(
          select,
          items
            .map(
              (item) =>
                `<option value="${escapeHtml(item.id)}" ${chosen(item) ? 'selected' : ''}>${escapeHtml(item.label || item.name)}</option>`,
            )
            .join(''),
        );
      })
      .catch(() => {
        const select = document.querySelector('#event-calendar');
        if (select) setHtml(select, '<option>Calendar</option>');
      });
    document.querySelector('#cancel-event').onclick = onBack;
    document.querySelector('#back-event').onclick = onBack;
    document.querySelector('#create-event').onclick = async () => {
      const title = document.querySelector('#event-title').value.trim();
      const calendar = document.querySelector('#event-calendar').value;
      const startDate = new Date(document.querySelector('#event-start').value);
      const endDate = new Date(document.querySelector('#event-end').value);
      if (!title || Number.isNaN(startDate.valueOf()) || endDate <= startDate)
        return notify('Check the event details');
      const endpoint = editing ? '/api/calendar/event/update' : '/api/calendar/event';
      // The bound payload must mirror exactly what the route validates: create has
      // no id, update has one.
      const event = { title, calendar, start: startDate.toISOString(), end: endDate.toISOString() };
      if (editing) event.id = String(existing.id || '');
      let approvalToken;
      try {
        approvalToken = await requestApproval(
          editing ? 'calendar.update' : 'calendar.create',
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
        notify(editing ? `Updated “${title}”` : `Created “${title}”`);
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
          `<i data-ux-icon="shield-check"></i> ${escapeHtml(reasonMessage)}${permissionReason ? ' <button type="button" class="link-button" id="event-connect-calendar">Connect Calendar</button>' : ''}`,
        );
      document
        .querySelector('#event-connect-calendar')
        ?.addEventListener('click', requestCalendarAccess);
      refreshIcons();
      notify(reasonMessage);
    };
    refreshIcons();
  }
  function showUpcomingEvents({ onBack: goBack = onBack } = {}) {
    onOpen();
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = 'Calendar · upcoming';
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-upcoming-events">${icon('arrow-left')} Habibi</button><span class="verified">● next 14 days</span></div><div class="workspace-heading"><span><p class="eyebrow">HABIBI · CALENDAR</p><h2>Next 14 days</h2></span><span class="status-pill">Upcoming</span></div><div class="agenda-list calendar-agenda"><div class="loading-state">${spinner()} Loading your calendar…</div></div>`,
    );
    document.querySelector('#back-upcoming-events').onclick = goBack;
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
            ? calendarAgendaMarkup(data.events)
            : '<div class="searching-local">No events in the next 14 days.</div>',
        );
        list
          .querySelectorAll('[data-event]')
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

  function requestCalendarAccess({ onDone } = {}) {
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
      // Without a system calendar (Windows, Linux) access means an account.
      if (result?.openSettings) return accounts.show({ onBack });
      if (onDone) return onDone(result);
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

  const loadCalendarEvents = createCalendarEventsLoader({ demoMode, demoEvents });
  const accounts = createCalendarAccounts({
    defaultView,
    resultsView,
    count,
    notify,
    onOpen,
    requestCalendarAccess,
    showUpcoming: showUpcomingEvents,
  });
  // Reminders (and other features) ask for the accounts screen this way
  // when there is no system settings pane to send the user to.
  window.addEventListener('habibi-open-settings', (event) => {
    if (event.detail === 'calendar-accounts') accounts.show({ onBack });
  });

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
    showAccounts: accounts.show,
    showDraft: showEventDraft,
    showUpcoming: showUpcomingEvents,
  };
}
