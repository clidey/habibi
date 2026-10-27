import { calendarDraftFromText } from '../calendar/event-intent.js';
import { escapeHtml } from '../../core/view-helpers.js';
import { setHtml } from '../../core/safe-dom.js';
import { browserCommand } from '../../../core/browser-url.js';
import { isConversationalQuery } from '../../core/query.js';

export function searchRoute(query) {
  if (isConversationalQuery(query)) return { label: 'HABIBI', description: 'a request for Habibi', result: { icon: 'agents', title: 'Ask Habibi', meta: query, tag: 'HABIBI', type: 'assistant' } };
  const url = browserCommand(query);
  if (url) return { label: 'HABIBI', description: 'a request to open a website', result: { icon: 'agents', title: `Open ${new URL(url).hostname}`, meta: `${url} · Open in your default browser`, tag: 'HABIBI', type: 'assistant' } };
  if (/\b(?:lunch|dinner|meeting|meet|appointment|call|event)\b/i.test(query) && /\b(?:tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.test(query)) {
    const event = calendarDraftFromText(query);
    return { label: 'CALENDAR', description: 'a new calendar event', result: { icon: 'calendar', title: `New event: ${event.title}`, meta: `${new Date(event.start).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · 1 hr · Review before saving`, tag: 'CALENDAR', type: 'calendar-intent' } };
  }
  if (/\bwhodb\b/i.test(query)) return { label: 'WHODB', description: 'a question about your WhoDB workspace', result: { icon: 'database', title: `WhoDB: ${query}`, meta: 'Open your workspace and connection settings', tag: 'WHODB', type: 'whodb' } };
  if (/\b(?:mail|email|inbox)\b/i.test(query)) return { label: 'MAIL', description: 'a request for Mail' };
  if (/\bwhatsapp\b/i.test(query)) return { label: 'WHATSAPP', description: 'a request for WhatsApp' };
  return null;
}
export function renderSearchRoute(route) {
  const strip = document.querySelector('#routing-strip');
  if (!strip) return;
  strip.classList.toggle('hidden', !route);
  if (route) setHtml(strip, `<b>ROUTED → ${escapeHtml(route.label)}</b><span>Habibi read this as <strong>${escapeHtml(route.description)}</strong></span><span class="routing-location">ON THIS MAC</span>`);
}
