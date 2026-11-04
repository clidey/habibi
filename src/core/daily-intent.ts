export interface DailyIntent {
  name: 'clipboard' | 'reminders' | 'focus' | 'recents';
  minutes?: number;
}
/** Exact utility intents work locally, even before a model has been configured. */
export function dailyIntent(value: string): DailyIntent | null {
  const text = value.trim().toLowerCase();
  if (
    /^(?:(?:today|tomorrow)\s+)?(?:please\s+)?(?:remind me\b|(?:create|add|set)\s+(?:a\s+)?reminder\b)/.test(
      text,
    )
  )
    return { name: 'reminders' };
  if (
    /^(?:(?:start|set|begin)\s+(?:a\s+)?)?(?:focus|pomodoro|(?:focus\s+)?timer)\b/.test(text) ||
    /^(?:start|set)\s+(?:a\s+)?\d+\s*(?:min(?:ute)?s?)\s+(?:focus|timer|break)\b/.test(text)
  ) {
    const match = text.match(/\b(\d{1,3})\s*(?:m|min(?:ute)?s?)\b/);
    const minutes = match ? Number(match[1]) : undefined;
    return { name: 'focus', ...(minutes && minutes <= 240 ? { minutes } : {}) };
  }
  if (/^(?:open|show)\s+(?:my\s+)?clipboard(?:\s+history)?$/.test(text))
    return { name: 'clipboard' };
  if (/^(?:open|show)\s+(?:my\s+)?recent(?:ly opened)?(?:\s+(?:files|items))?$/.test(text))
    return { name: 'recents' };
  return null;
}
