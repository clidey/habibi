export function localDateTime(date) {
  if (!date || !Number.isFinite(date.valueOf())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
/** Build an editable reminder, keeping the task separate from its scheduling words. */
export function reminderDraft(source = '', now = new Date()) {
  const text = source.trim();
  const lower = text.toLowerCase();
  const date = new Date(now);
  let hasDate = false;
  const relative = lower.match(/\bin\s+(\d{1,3})\s+(minutes?|mins?|hours?|days?)\b/);
  if (relative) {
    date.setTime(
      now.getTime() +
        Number(relative[1]) *
          (/^hour/.test(relative[2]) ? 3600000 : /^day/.test(relative[2]) ? 86400000 : 60000),
    );
    hasDate = true;
  } else {
    if (/\btomorrow\b/.test(lower)) {
      date.setDate(date.getDate() + 1);
      hasDate = true;
    } else if (/\btoday\b/.test(lower)) hasDate = true;
    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const day = weekdays.findIndex((day) => new RegExp(`\\b${day}\\b`).test(lower));
    if (day >= 0) {
      let offset = (day - now.getDay() + 7) % 7;
      if (!offset || /\bnext\b/.test(lower)) offset += 7;
      date.setDate(now.getDate() + offset);
      hasDate = true;
    }
    const iso = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) {
      const candidate = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12);
      if (candidate.getMonth() === Number(iso[2]) - 1 && candidate.getDate() === Number(iso[3])) {
        date.setTime(candidate.valueOf());
        hasDate = true;
      }
    }
    const time = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2}):(\d{2})\b/);
    let hour = 9,
      minute = 0;
    if (time) {
      hour = Number(time[1] || time[4]);
      minute = Number(time[2] || time[5] || 0);
      if (time[3]) {
        if (hour < 1 || hour > 12) return { title: titleOf(text), due: '', notes: '' };
        hour = (hour % 12) + (time[3] === 'pm' ? 12 : 0);
      }
      if (hour <= 23 && minute <= 59) hasDate = true;
      else return { title: titleOf(text), due: '', notes: '' };
    }
    if (/\bnoon\b/.test(lower)) {
      hour = 12;
      hasDate = true;
    }
    if (/\bmidnight\b/.test(lower)) {
      hour = 0;
      hasDate = true;
    }
    date.setHours(hour, minute, 0, 0);
    if (
      hasDate &&
      date <= now &&
      !/\b(?:today|tomorrow|\d{4}-\d{2}-\d{2})\b/.test(lower) &&
      day < 0
    )
      date.setDate(date.getDate() + 1);
  }
  return { title: titleOf(text), due: hasDate ? localDateTime(date) : '', notes: '' };
}
function titleOf(text) {
  const task = text.match(/\bto\s+(.+)$/i);
  return (
    task
      ? task[1]
      : text.replace(/^(?:please\s+)?(?:remind me|(?:create|add|set)\s+(?:a\s+)?reminder)\s*/i, '')
  )
    .replace(
      /\s+(?:(?:on|next)\s+)?(?:today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday|\d{4}-\d{2}-\d{2})\b.*$/i,
      '',
    )
    .replace(/\s+(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight)\b.*$/i, '')
    .replace(/\s+in\s+\d+\s+(?:minutes?|mins?|hours?|days?)\b.*$/i, '')
    .trim()
    .slice(0, 500);
}
