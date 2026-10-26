import { escapeHtml, icon } from '../../core/view-helpers.js';

export function calendarAgendaMarkup(events) {
  const days = new Map();
  for (const event of events) {
    const start = new Date(event.start);
    const key = start.toDateString();
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(event);
  }
  return [...days.entries()].map(([day, items]) => `<section class="calendar-day"><time>${escapeHtml(new Date(day).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }))}</time><div>${items.map((event) => {
    const start = new Date(event.start);
    const minutes = (new Date(event.end) - start) / 60000;
    const allDay = event.allDay || (minutes >= 23 * 60 && start.getHours() === 0);
    const when = allDay ? 'All day' : start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    return `<button class="calendar-event ${allDay ? 'all-day' : ''}" data-event="${encodeURIComponent(JSON.stringify(event))}"><i></i><time>${escapeHtml(when)}</time><span><b>${escapeHtml(event.title || 'Untitled event')}</b><small>${allDay ? '' : `${minutes < 60 ? minutes + ' min' : Math.round(minutes / 6) / 10 + ' hr'} · `}${escapeHtml(event.calendar || 'Calendar')}</small></span>${icon('chevron-right')}</button>`;
  }).join('')}</div></section>`).join('');
}
