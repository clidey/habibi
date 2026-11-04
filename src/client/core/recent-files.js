export async function recentRequest(method = 'GET', value) {
  const response = await fetch('/api/recent-files', { method, ...(value ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}) });
  const result = await response.json(); if (!result.ok) throw new Error(result.error || 'Could not read recent files.'); return result;
}
export async function recentAction(action, item) {
  if (action === 'attach') {
    if (!item.available || item.kind !== 'file') throw new Error('Choose an available file to attach.');
    if (item.size > 8 * 1024 * 1024) throw new Error('Attachments must be smaller than 8 MB.');
    if (document.querySelector('.mail-compose') && window.__habibiAttachRecentPath) window.__habibiAttachRecentPath(item.path, item.name);
    else if (window.__habibiNativeDroppedFiles) await window.__habibiNativeDroppedFiles([item.path]);
    return;
  }
  if (action === 'open') {
    const result = await fetch('/api/open-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: item.path }) }).then(response => response.json());
    if (!result.ok) throw new Error('This file could not be opened.'); return;
  }
  if (action === 'pin') return recentRequest('PATCH', { id: item.id, pinned: !item.pinned });
  if (action === 'remove') return recentRequest('DELETE', { id: item.id });
  if (action === 'clear') return recentRequest('DELETE', {});
}
