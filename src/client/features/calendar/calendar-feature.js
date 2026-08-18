import { setHtml } from '../../core/safe-dom.js';
import { approvalNotice, escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';

/** Owns EventKit transport, calendar views, and cached proactive home context. */
export function createCalendarFeature({ defaultView, resultsView, count, notify, requestApproval, applyHomeLayout, onBack, onMailThread, demoMode = false, demoEvents = [], demoMail = [] }) {
  let proactiveContext = { events:[], mail:[], provider:'' };
  let proactiveLoadedAt = 0;
  let proactiveLoadInFlight = null;
  const proactiveCacheMs = 60_000;

function localDateTime(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function showEventDraft(existing) {
  const start = new Date();
  start.setDate(start.getDate() + 1); start.setHours(12, 30, 0, 0);
  const eventStart = existing ? new Date(existing.start) : start;
  const eventEnd = existing ? new Date(existing.end) : new Date(start.getTime() + 60 * 60 * 1000);
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = 'Calendar · draft';
  setHtml(resultsView, `<div class="result-header conversation-mode"><b>Create event</b><span class="verified">● reviewed before save</span></div>
    <section class="event-draft"><div class="event-title"><span class="icon calendar">${icon('calendar-days')}</span><input id="event-title" value="${escapeHtml(existing ? existing.title : '')}" placeholder="Event title" aria-label="Event title" /></div><div class="event-field"><label>Starts</label><input id="event-start" type="datetime-local" value="${localDateTime(eventStart)}" /></div><div class="event-field"><label>Ends</label><input id="event-end" type="datetime-local" value="${localDateTime(eventEnd)}" /></div><div class="event-field"><label>Calendar</label><select id="event-calendar"><option>Loading calendars…</option></select></div><div class="event-note"><i data-lucide="shield-check"></i> ${existing ? approvalNotice('Saving these changes') : approvalNotice('Creating this event')}</div><div class="event-actions"><button class="secondary" id="cancel-event">Cancel</button><button class="primary" id="create-event">${existing ? 'Save changes' : 'Create event'} <kbd>⌘ ↵</kbd></button></div></section>`);
  fetch('/api/calendars').then(response => response.json()).then(data => {
    const select = document.querySelector('#event-calendar');
    if (!select) return;
    const names = data.ok && data.calendars.length ? data.calendars : ['Calendar'];
    setHtml(select, names.map(name => `<option ${existing && name === existing.calendar ? 'selected' : ''}>${escapeHtml(name)}</option>`).join(''));
  }).catch(() => { const select = document.querySelector('#event-calendar'); if (select) setHtml(select, '<option>Calendar</option>'); });
  document.querySelector('#cancel-event').onclick = onBack;
  document.querySelector('#create-event').onclick = async () => {
    const title = document.querySelector('#event-title').value.trim();
    const calendar = document.querySelector('#event-calendar').value;
    const startDate = new Date(document.querySelector('#event-start').value);
    const endDate = new Date(document.querySelector('#event-end').value);
    if (!title || Number.isNaN(startDate.valueOf()) || endDate <= startDate) return notify('Check the event details');
    const endpoint = existing ? '/api/calendar/event/update' : '/api/calendar/event';
    // The bound payload must mirror exactly what the route validates: create has
    // no id, update has one.
    const event = { title, calendar, start:startDate.toISOString(), end:endDate.toISOString() };
    if (existing) event.id = String(existing.id || '');
    let approvalToken;
    try { approvalToken = await requestApproval(existing ? 'calendar.update' : 'calendar.create', event); }
    catch (error) { return notify(error.message); }
    const response = await fetch(endpoint, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ ...event, approvalToken }) });
    const result = await response.json();
    if (result.ok) { notify(existing ? `Updated “${title}”` : `Created “${title}”`); return onBack(); }
    // A flat "permission or save failed" gives no way forward. Reuse the same
    // reason-coded copy loadCalendarEvents() already surfaces for reads, and
    // the same "Connect Calendar" affordance, when the failure looks
    // permission-related rather than a one-off AppleScript error.
    let reasonMessage = 'Calendar could not save this event. Try again.';
    let permissionReason = null;
    try { await loadCalendarEvents(); }
    catch (permissionError) { reasonMessage = permissionError.message; permissionReason = permissionError.permissionReason; }
    const note = document.querySelector('.event-draft .event-note');
    if (note) setHtml(note, `<i data-lucide="shield-check"></i> ${escapeHtml(reasonMessage)}${permissionReason ? ' <button type="button" class="link-button" id="event-connect-calendar">Connect Calendar</button>' : ''}`);
    document.querySelector('#event-connect-calendar')?.addEventListener('click', requestCalendarAccess);
    refreshIcons();
    notify(reasonMessage);
  };
  refreshIcons();
}
function showUpcomingEvents({ onBack = onBack } = {}) {
  defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent = 'Calendar · upcoming';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-upcoming-events">${icon('arrow-left')} Habibi</button><span class="verified">● next 14 days</span></div><div class="agenda-list"><div class="loading-state"><span class="spinner"></span> Loading your calendar…</div></div>`);
  document.querySelector('#back-upcoming-events').onclick = onBack;
  loadCalendarEvents().then(data => {
    const list = document.querySelector('.agenda-list');
    if (!list) return;
    if (!data.ok) return setHtml(list, '<div class="searching-local">Calendar access is needed to show upcoming events.</div>');
    setHtml(list, data.events.length ? data.events.map(event => `<button class="agenda-event" data-event="${encodeURIComponent(JSON.stringify(event))}"><span class="icon calendar">${icon('calendar-days')}</span><span><b>${escapeHtml(event.title || 'Untitled event')}</b><small>${escapeHtml(new Date(event.start).toLocaleString([], { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }))} · ${escapeHtml(event.calendar)}</small></span><i data-lucide="chevron-right"></i></button>`).join('') : '<div class="searching-local">No events in the next 14 days.</div>');
    list.querySelectorAll('.agenda-event').forEach(button => button.onclick = () => showEventDraft(JSON.parse(decodeURIComponent(button.dataset.event))));
    refreshIcons();
  }).catch(() => { const list = document.querySelector('.agenda-list'); if (list) setHtml(list, '<div class="searching-local">Calendar is unavailable right now.</div>'); });
}
function renderProactiveEvents(events) {
  const glance = document.querySelector('#agenda-glance');
  if (!glance) return;
  const title = document.querySelector('#home-title');
  if (!events.length) {
    title.textContent = 'You’re clear for now';
    document.querySelector('#agenda-label').textContent = 'ALL CLEAR';
    setHtml(glance, '<div class="clear-day"><span class="icon calendar">' + icon('calendar-check') + '</span><span><b>No upcoming events in the next two weeks.</b><small>Use the command bar when you’re ready to plan something.</small></span></div>');
  } else {
    const next = events[0];
    title.textContent = next.title || 'Your next event';
    document.querySelector('#agenda-label').textContent = 'UP NEXT';
    setHtml(glance, events.map((event, index) => {
      const start = new Date(event.start);
      const duration = Math.round((new Date(event.end) - start) / 60000);
      const allDay = duration >= 23 * 60 && start.getHours() === 0 && start.getMinutes() === 0;
      const when = allDay ? 'All day' : start.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
      const detail = allDay ? event.calendar : `${event.calendar} · ${duration} min`;
      return `<button class="glance-event ${index === 0 ? 'next' : ''}" data-event="${encodeURIComponent(JSON.stringify(event))}"><span class="glance-time">${escapeHtml(start.toLocaleDateString([], { weekday:'short' }))}<b>${escapeHtml(when)}</b></span><span class="glance-copy"><b>${escapeHtml(event.title || 'Untitled event')}</b><small>${escapeHtml(detail)}</small></span><i data-lucide="chevron-right"></i></button>`;
    }).join(''));
    glance.querySelectorAll('.glance-event').forEach(button => button.onclick = () => showEventDraft(JSON.parse(decodeURIComponent(button.dataset.event))));
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
  if (!mail.length && !next) { setHtml(target, ''); if (mailTarget) setHtml(mailTarget, ''); return; }
  const nextDetail = next ? `${next.title || 'An event'} · ${new Date(next.start).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}` : '';
  const summaryTitle = mail.length && next ? `${mail.length} recent email${mail.length === 1 ? '' : 's'} · next up` : mail.length ? `${mail.length} recent email${mail.length === 1 ? '' : 's'}` : 'Your next moment';
  const summaryDetail = nextDetail || 'Nothing new needs your attention.';
  const mailCards = mail.slice(0, 3).map(thread => `<button class="briefing-mail" data-proactive-mail="${thread.id}" data-proactive-provider="${escapeHtml(thread.accountId || provider)}"><span class="icon gmail">${icon('mail')}</span><span><b>${escapeHtml(thread.subject || '(No subject)')}</b><small>${escapeHtml(thread.from || 'Unknown sender')} · ${escapeHtml(thread.accountEmail || '')}</small></span><time>${new Date(thread.timestamp).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}</time></button>`).join('');
  setHtml(target, `<span class="briefing-heading">HABIBI BRIEFING</span><div class="briefing-summary"><span class="briefing-icon">${icon('sparkles')}</span><span class="briefing-copy"><b>${escapeHtml(summaryTitle)}</b><small>${escapeHtml(summaryDetail)}</small></span></div>`);
  if (mailTarget) {
    setHtml(mailTarget, mailCards ? `<span class="briefing-heading">RECENT EMAIL</span><div class="proactive-mail-list">${mailCards}</div>` : '');
    mailTarget.querySelectorAll('[data-proactive-mail]').forEach(button => button.onclick = () => onMailThread(button.dataset.proactiveMail, button.dataset.proactiveProvider));
  }
  applyHomeLayout();
  refreshIcons();
}
function loadProactiveHome({ force = false } = {}) {
  const glance = document.querySelector('#agenda-glance');
  if (!glance) return;
  if (demoMode) {
    proactiveContext = { events:demoEvents, mail:demoMail, provider:'demo-mail' };
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
  proactiveContext = { events:[], mail:[], provider:'' };
  document.querySelector('#home-date').textContent = now.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' }).toUpperCase();
  // A native EventKit/permission round-trip on first load can take a few
  // seconds; a plain spinner with no explanation reads as stuck rather than
  // normal, which is the exact pattern that caused a full debugging session
  // over what turned out to be an ordinary slow first launch.
  setHtml(glance, '<div class="loading-state"><span class="spinner"></span><span class="loading-copy">Checking your calendar…<small>Asking macOS for calendar access the first time can take a moment.</small></span></div>');
  const briefing = document.querySelector('#proactive-briefing');
  if (briefing) setHtml(briefing, '<div class="loading-state"><span class="spinner"></span><span class="loading-copy">Checking recent context…<small>Reading calendar and mail locally before Habibi can summarize your day.</small></span></div>');
  const calendarLoad = loadCalendarEvents().then(data => {
    if (!data.ok) throw new Error('Calendar unavailable');
    const events = data.events.slice(0, 4);
    proactiveContext.events = events;
    renderProactiveEvents(events);
    renderProactiveBriefing();
  }).catch(() => {
    document.querySelector('#home-title').textContent = 'Your day, privately';
    document.querySelector('#agenda-label').textContent = 'CALENDAR';
    setHtml(glance, '<button class="clear-day calendar-connect" id="connect-calendar"><span class="icon calendar">' + icon('calendar-clock') + '</span><span><b>Connect Calendar to see what’s next.</b><small>Allow Calendar access</small></span><i data-lucide="chevron-right"></i></button>');
    document.querySelector('#connect-calendar')?.addEventListener('click', requestCalendarAccess);
    applyHomeLayout();
    refreshIcons();
  });
  const mailLoad = fetch('/api/mail/status').then(response => response.json()).then(data => {
    const accounts = (data.accounts || []).filter(item => item.connected);
    if (!accounts.length) return;
    return fetch('/api/mail/recent?provider=all&hours=4').then(response => response.json()).then(recent => {
      if (!recent.ok) return;
      proactiveContext.mail = recent.threads || [];
      proactiveContext.provider = 'all';
      renderProactiveBriefing();
    });
  }).catch(() => {});
  proactiveLoadInFlight = Promise.allSettled([calendarLoad, mailLoad]).finally(() => {
    proactiveLoadedAt = Date.now();
    proactiveLoadInFlight = null;
    if (!proactiveContext.events.length && !proactiveContext.mail.length) renderProactiveBriefing();
  });
  return proactiveLoadInFlight;
}

function requestCalendarAccess() {
  const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
  if (!nativeBridge) { showUpcomingEvents(); return; }
  const button = document.querySelector('#connect-calendar');
  if (button) {
    button.disabled = true;
    button.querySelector('small').textContent = 'Requesting Calendar access…';
  }
  window.__habibiNativeCalendarAccess = result => {
    window.__habibiNativeCalendarAccess = null;
    if (!result?.ok) {
      if (button) { button.disabled = false; button.querySelector('small').textContent = result?.reason === 'writeOnly' ? 'Allow Full Calendar access' : 'Allow Calendar access'; }
      notify(result?.message || 'Calendar access was not granted.');
      return;
    }
    loadProactiveHome({ force:true });
  };
  nativeBridge.postMessage({ type:'calendarAccess' });
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
    window.__habibiNativeCalendarEvents = payload => {
      clearTimeout(timer);
      window.__habibiNativeCalendarEvents = null;
      if (payload?.ok) return resolve(payload);
      // A write-only grant is the common case and is recoverable, so name it
      // rather than reporting a generic failure the user cannot act on.
      const reasons = {
        writeOnly:'Habibi can only add events. Allow full calendar access in System Settings → Privacy & Security → Calendars.',
        denied:'Calendar access is turned off. Allow it in System Settings → Privacy & Security → Calendars.',
        notDetermined:'Habibi has not been granted calendar access yet.',
      };
      const error = new Error(reasons[payload?.reason] || 'Calendar access is unavailable.');
      error.permissionReason = reasons[payload?.reason] ? payload.reason : null;
      reject(error);
    };
    nativeBridge.postMessage({ type:'calendarEvents' });
  });
}

  return { hasContext:() => Boolean(proactiveContext.events.length || proactiveContext.mail.length), loadEvents:loadCalendarEvents, loadHome:loadProactiveHome, requestAccess:requestCalendarAccess, showDraft:showEventDraft, showUpcoming:showUpcomingEvents };
}
