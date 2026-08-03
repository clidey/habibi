export const icon = name => `<i data-lucide="${name}"></i>`;

export const refreshIcons = () => {
  window.lucide?.createIcons({ attrs:{ 'stroke-width':1.8 } });
};

export const chatTime = timestamp => {
  const date = new Date(timestamp * 1000);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
    : date.toLocaleDateString([], { month:'short', day:'numeric' });
};

export const initials = name => String(name || '?')
  .split(/\s+/)
  .map(part => part[0])
  .join('')
  .slice(0, 2)
  .toUpperCase();

export const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;',
})[char]);
