/** Parse a local, editable calendar draft without exposing data to a model. */
export function calendarDraftFromText(text = '') {
  const now = new Date();
  const lower = String(text).toLowerCase();
  const weekdays = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
  const start = new Date(now);
  const weekday = Object.entries(weekdays).find(([name]) => lower.includes(name));
  if (lower.includes('tomorrow')) start.setDate(start.getDate() + 1);
  else if (weekday) {
    let days = (weekday[1] - start.getDay() + 7) % 7;
    if (days === 0 || lower.includes('next')) days += 7;
    start.setDate(start.getDate() + days);
  } else start.setDate(start.getDate() + 1);
  const time = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|–|—)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  const hour = (value, meridiem) => { let result = Number(value); if (meridiem === 'pm' && result < 12) result += 12; if (meridiem === 'am' && result === 12) result = 0; return result; };
  if (time) start.setHours(hour(time[1], time[3] || time[6]), Number(time[2] || 0), 0, 0);
  else start.setHours(12, 0, 0, 0);
  const end = new Date(start);
  if (time) end.setHours(hour(time[4], time[6] || time[3]), Number(time[5] || 0), 0, 0);
  else end.setHours(start.getHours() + 1);
  if (end <= start) end.setTime(start.getTime() + 60 * 60 * 1000);
  const person = String(text).match(/\b(?:meeting|meet|call|lunch|dinner)\s+(?:with\s+)?([^,?.]+?)(?:\s+(?:next|tomorrow|on)\b|$)/i)?.[1]?.trim();
  const title = person ? `Meeting with ${person}` : 'New event';
  return { title, start:start.toISOString(), end:end.toISOString(), calendar:'Calendar' };
}
