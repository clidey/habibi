const legacy = {
  '📝': 'file-text', '💡': 'ai', '📌': 'pin', '🚀': 'promote', '🎯': 'flag',
  '💬': 'chat', '📚': 'book', '🗂️': 'folder', '🧠': 'ai', '✅': 'check-circle',
  '🎨': 'camera', '🏡': 'home', '💼': 'organization', '🧪': 'beaker', '🌿': 'globe',
  '🧾': 'receipt', '⭐': 'star', '❤️': 'star', '🔥': 'promote', '☕': 'clock',
  '🛠️': 'settings', '📅': 'calendar', '✈️': 'globe', '🎵': 'play', '💻': 'monitor',
  '📊': 'chart', '🌍': 'globe',
};

/** Older notes retain their saved content while displaying catalog icons. */
export function noteIconName(note) {
  return typeof note?.icon === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(note.icon)
    ? note.icon : legacy[note?.emoji] || 'file-text';
}
