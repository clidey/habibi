/** Visual identity and exact launcher aliases for Habibi's own workspaces. */
export const builtinApps = Object.freeze({
  clipboard: { icon: 'copy', aliases: ['clipboard', 'clipboard history', 'my clipboard'] },
  reminders: { icon: 'check-circle', aliases: ['reminders', 'my reminders', 'tasks'] },
  focus: { icon: 'clock', aliases: ['focus', 'focus timer', 'pomodoro', 'timer'] },
  recents: { icon: 'folder', aliases: ['recents', 'recent files', 'recent items', 'recently opened'] },
  notes: { icon: 'file-text', aliases: ['notes', 'my notes'] },
  emoji: { icon: null, aliases: ['emoji', 'emojis', 'emoji picker'] },
  teleprompter: { icon: 'scroll-text', aliases: ['teleprompter'] },
  email: { icon: 'mail', aliases: ['mail', 'email', 'inbox'] },
  whatsapp: { icon: 'whatsapp', aliases: ['whatsapp'] },
  agenda: { icon: 'calendar-days', aliases: ['calendar', 'upcoming events'] },
  event: { icon: 'calendar-days', aliases: ['create event'] },
  whodb: { icon: 'database', aliases: ['whodb'] },
  preferences: { icon: 'sliders-horizontal', aliases: ['settings', 'preferences', 'prefs'] },
  assistant: { icon: 'sparkles', aliases: ['ask habibi', 'habibi'] },
  kubernetes: { icon: 'ship-wheel', aliases: ['kubernetes', 'k8s'] },
  codex: { icon: 'terminal-square', aliases: ['codex', 'codex sessions'] },
  claude: { icon: 'message-circle-more', aliases: ['claude', 'claude code sessions'] },
  agent: { icon: 'bot', aliases: ['agent sessions'] },
  skills: { icon: 'plug-zap', aliases: ['skills'] },
  file: { icon: 'folder', aliases: ['find local files'] },
});

export function builtinAppForQuery(query) {
  const normalized = String(query)
    .trim()
    .toLowerCase()
    .replace(/^(?:open|show|go to)\s+/, '')
    .replace(/[.!]+$/, '');
  return (
    Object.keys(builtinApps).find((type) => builtinApps[type].aliases.includes(normalized)) || null
  );
}
