import { FileToolsError } from './access';
export function dailyPlanningPrompt(now = new Date()): string {
  return `You are Habibi's daily utility planner. Current local time: ${now.toString()}, ISO: ${now.toISOString()}. Return ONE JSON object, no Markdown, never execute. For a focus/countdown timer: {"kind":"timer","action":"start"|"pause"|"resume"|"reset"|"show","seconds":integer 60..14400,"label":"short name"}. For Apple Reminders: {"kind":"reminder","action":"create"|"list"|"complete","title":"task or existing task title","due":"ISO timestamp with timezone or empty","notes":"optional"}. For clipboard: {"kind":"clipboard"}. For recent files: {"kind":"recents"}. Otherwise {"kind":"clarify","question":"specific question"}. Relative dates must use the given local clock/timezone. Keep the task separate from scheduling words. Missing dates stay empty; never invent people or data. Writes require the user's subsequent review button. Never claim an action happened.`;
}
export function normalizeDailyPlan(value: unknown) {
  const data =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const text = (value: unknown, limit = 500) =>
    typeof value === 'string' ? value.trim().slice(0, limit) : '';
  if (data.kind === 'clipboard' || data.kind === 'recents') return { kind: data.kind };
  if (data.kind === 'clarify')
    return { kind: 'clarify', question: text(data.question) || 'Which task should I prepare?' };
  if (data.kind === 'timer') {
    if (!['start', 'pause', 'resume', 'reset', 'show'].includes(String(data.action)))
      throw new FileToolsError('The timer action is invalid.');
    const seconds = data.seconds ?? 1500;
    if (!Number.isInteger(seconds) || Number(seconds) < 60 || Number(seconds) > 14400)
      throw new FileToolsError('Choose a timer between 1 minute and 4 hours.');
    return {
      kind: 'timer',
      action: String(data.action),
      seconds: Number(seconds),
      label: text(data.label, 100) || 'Focus',
    };
  }
  if (data.kind === 'reminder') {
    if (
      !['create', 'list', 'complete'].includes(String(data.action)) ||
      (data.action !== 'list' && !text(data.title))
    )
      throw new FileToolsError('The reminder needs a task title.');
    const due = text(data.due, 100);
    if (due && (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(due) || !Number.isFinite(Date.parse(due))))
      throw new FileToolsError('The reminder date is invalid.');
    return {
      kind: 'reminder',
      action: String(data.action),
      title: text(data.title),
      due,
      notes: text(data.notes, 2000),
    };
  }
  throw new FileToolsError(
    'The model could not choose a daily utility. Try stating the task and time.',
  );
}
