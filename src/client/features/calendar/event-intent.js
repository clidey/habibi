/** Parse an editable draft locally; no model or network is needed. */
export function calendarDraftFromText(text = '', now = new Date()) {
  const lower = String(text).toLowerCase();
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const start = new Date(now);
  const weekday = weekdays.findIndex((name) => new RegExp(`\\b${name}\\b`).test(lower));
  if (/\btomorrow\b/.test(lower)) start.setDate(start.getDate() + 1);
  else if (weekday >= 0) {
    let days = (weekday - start.getDay() + 7) % 7;
    if (days === 0 || /\bnext\b/.test(lower)) days += 7;
    start.setDate(start.getDate() + days);
  } else if (!/\btoday\b/.test(lower)) start.setDate(start.getDate() + 1);
  const range = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|–|—)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  const single = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
  const hour = (value, meridiem) => {
    let result = Number(value);
    if (meridiem === 'pm' && result < 12) result += 12;
    if (meridiem === 'am' && result === 12) result = 0;
    return result;
  };
  if (range) start.setHours(hour(range[1], range[3] || range[6]), Number(range[2] || 0), 0, 0);
  else if (single) start.setHours(hour(single[1] || single[4], single[3]), Number(single[2] || single[5] || 0), 0, 0);
  else start.setHours(12, 0, 0, 0);
  const end = new Date(start);
  if (range) end.setHours(hour(range[4], range[6] || range[3]), Number(range[5] || 0), 0, 0);
  else end.setHours(start.getHours() + 1);
  if (end <= start) end.setTime(start.getTime() + 60 * 60 * 1000);
  const titleText = String(text)
    .replace(/^(?:please\s+)?(?:create|schedule|book|add)\s+(?:an?\s+)?(?:event\s+)?/i, '')
    .replace(/\s+(?:(?:next|on)\s+)?(?:tomorrow|today|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b.*$/i, '')
    .replace(/\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b.*$/i, '')
    .replace(/[?.!,]+$/, '').trim();
  const title = titleText ? titleText[0].toUpperCase() + titleText.slice(1) : 'New event';
  return { title, start: start.toISOString(), end: end.toISOString(), calendar: 'Calendar' };
}
