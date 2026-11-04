export async function copyNoteText(value, notify) {
  try {
    if (window.webkit?.messageHandlers?.habibiNative) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.__habibiNotesCopyResult = null; reject(new Error('Clipboard unavailable')); }, 3000);
      window.__habibiNotesCopyResult = ok => { clearTimeout(timer); window.__habibiNotesCopyResult = null; ok ? resolve() : reject(new Error('Clipboard unavailable')); };
      window.webkit.messageHandlers.habibiNative.postMessage({ type: 'copyNoteText', text: value });
    });
    else await navigator.clipboard.writeText(value);
    notify('Copied');
    return true;
  } catch { notify('Could not copy. Select the Markdown and copy it directly.'); return false; }
}
export async function exportNote(note, notify) {
  const text = `# ${note.title || 'Untitled'}\n\n${note.body}\n`;
  const filename = `${(note.title || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 120)}.md`;
  const bridge = window.webkit?.messageHandlers?.habibiNative;
  if (bridge) {
    window.__habibiNotesExportResult = result => { if (result.ok) notify('Markdown exported'); else if (!result.cancelled) notify('Could not export the note. Try copying its Markdown.'); };
    bridge.postMessage({ type: 'exportNote', text, filename });
  } else {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
export async function importNotes(files, session, folderId, notify) {
  const imported = [];
  for (const file of [...files].slice(0, 50)) {
    if (!/\.(?:md|markdown)$/i.test(file.name) || file.size > 1048576) { notify(`Skipped ${file.name}: use a Markdown file under 1 MB.`); continue; }
    let body = await file.text();
    if (body.length > 262144) { notify(`Skipped ${file.name}: this note is too long.`); continue; }
    const heading = /^# ([^\n]+)\r?\n(?:\r?\n)?/.exec(body);
    const title = (heading ? heading[1] : file.name.replace(/\.(?:md|markdown)$/i, '')).slice(0, 200);
    if (heading) body = body.slice(heading[0].length);
    imported.push(await session.create({ title, body, folderId }));
  }
  if (imported.length) notify(`Imported ${imported.length} note${imported.length === 1 ? '' : 's'}`);
  return imported;
}
