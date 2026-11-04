import { folderDialog } from './notes-dialogs.js';

const dragType = 'application/x-habibi-notes';

/** Sidebar organization uses stable note IDs; the store commits each drop atomically. */
export function createNotesDrag({ root, session, getNotes, getFolder, onOrganized, notify }) {
  let picked = new Set(); let dragging = []; let target = null; let busy = false; let wasOpen = false;
  const picker = () => root.querySelector('.notes-collection-picker');
  const hint = root.querySelector('#notes-drag-hint');
  function clearTarget() {
    root.querySelectorAll('[data-note-drop]').forEach(item => { delete item.dataset.noteDrop; });
    target = null;
  }
  function paint() {
    const visible = new Set(getNotes().map(note => note.id));
    picked = new Set([...picked].filter(id => visible.has(id)));
    root.querySelector('#notes-drop-group').hidden = picked.size < 2 || busy;
    root.querySelector('#notes-drop-group-label').textContent = `Group ${picked.size} pages`;
    root.querySelectorAll('[data-note]').forEach(row => {
      const note = session.library.notes.find(note => note.id === row.dataset.note);
      row.draggable = Boolean(note && !note.deletedAt && !busy);
      row.classList.toggle('notes-drag-selected', picked.has(row.dataset.note));
      row.setAttribute('aria-pressed', String(picked.has(row.dataset.note)));
      row.title = 'Drag to move or group · ⌘ click to select multiple';
    });
  }
  function finish() {
    clearTarget(); dragging = [];
    root.classList.remove('notes-dragging');
    root.querySelector('#notes-drop-group').hidden = true;
    if (picker()) picker().open = wasOpen;
    hint.hidden = true; paint();
  }
  function dragStart(event) {
    const row = event.target.closest('[data-note]');
    if (!row || !row.draggable || busy) return;
    if (!picked.has(row.dataset.note)) picked = new Set([row.dataset.note]);
    dragging = getNotes().filter(note => picked.has(note.id)).map(note => note.id);
    if (!dragging.length) return;
    event.dataTransfer.setData(dragType, JSON.stringify(dragging));
    event.dataTransfer.effectAllowed = 'move';
    wasOpen = Boolean(picker()?.open);
    if (picker()) picker().open = false;
    root.classList.add('notes-dragging');
    root.querySelector('#notes-drop-group').hidden = dragging.length < 2;
    hint.hidden = false; hint.textContent = 'Drop into a folder, between pages, or onto a page to group.';
    paint();
  }
  function locate(event) {
    const folder = event.target.closest('[data-folder]');
    if (folder && folder.dataset.folder !== 'trash') return { row: folder, action: 'move', folderId: folder.dataset.folder === 'all' ? null : folder.dataset.folder };
    if (event.target.closest('#notes-drop-group') && dragging.length > 1) return { row: root.querySelector('#notes-drop-group'), action: 'group', folderId: getFolder() };
    const row = event.target.closest('[data-note]');
    if (!row || dragging.includes(row.dataset.note)) return null;
    const rect = row.getBoundingClientRect();
    const fraction = (event.clientY - rect.top) / rect.height;
    return { row, action: fraction < .25 || fraction > .75 ? 'reorder' : 'group', targetId: row.dataset.note, position: fraction < .25 ? 'before' : 'after' };
  }
  function dragOver(event) {
    if (!dragging.length || busy) return;
    event.preventDefault(); event.stopPropagation();
    clearTarget();
    if (event.target.closest('.notes-collection-picker > summary')) {
      picker().open = true; event.dataTransfer.dropEffect = 'move'; hint.textContent = 'Drop on a folder to move these pages.'; return;
    }
    if (!event.target.closest('.notes-collection-picker') && picker()) picker().open = false;
    target = locate(event);
    event.dataTransfer.dropEffect = target ? 'move' : 'none';
    if (!target) return;
    target.row.dataset.noteDrop = target.action === 'reorder' ? target.position : 'inside';
    hint.textContent = target.action === 'group' ? `Create a folder with ${dragging.length + (target.targetId ? 1 : 0)} pages` : target.action === 'move' ? `Move to ${target.row.querySelector('span')?.textContent || 'All notes'}` : `Move ${target.position} this page`;
  }
  async function organize(ids, value) {
    busy = true; root.inert = true; root.setAttribute('aria-busy', 'true'); paint();
    try {
      const data = await session.organize(ids, value);
      picked.clear(); busy = false;
      const folderId = value.action === 'group' ? data.notes.find(note => note.id === ids[0]).folderId : value.action === 'move' ? value.folderId : undefined;
      await onOrganized({ folderId, noteId: ids[0] });
      notify(value.action === 'group' ? 'Folder created' : value.action === 'move' ? 'Pages moved' : 'Page order saved');
    } finally { busy = false; root.inert = false; root.removeAttribute('aria-busy'); paint(); }
  }
  function group(ids, targetId) {
    if (busy || ids.length < (targetId ? 1 : 2)) return;
    if (targetId && !ids.includes(targetId)) ids.push(targetId);
    const targetNote = session.library.notes.find(note => note.id === targetId);
    const parent = targetNote?.folderId ?? (session.library.folders.some(folder => folder.id === getFolder()) ? getFolder() : null);
    folderDialog(root.querySelector('#notes-dialog-host'), session.library.folders, null,
      name => organize(ids, { action: 'group', name, folderId: parent }));
  }
  const groupPicked = () => group([...picked]);
  root.querySelector('#notes-drop-group').addEventListener('click', groupPicked);
  function drop(event) {
    if (!dragging.length) return;
    event.preventDefault(); event.stopPropagation();
    const destination = locate(event); const ids = [...dragging];
    finish();
    if (!destination || busy) return;
    if (destination.action === 'group') {
      group(ids, destination.targetId);
    } else {
      const { action, targetId, position, folderId } = destination;
      organize(ids, { action, targetId, position, folderId: action === 'reorder' ? getFolder() : folderId }).catch(error => notify(error.message));
    }
  }
  function dragLeave(event) { if (!root.contains(event.relatedTarget)) clearTarget(); }
  function pointerDown(event) {
    if (!event.target.closest('.notes-collection-picker') && picker()) picker().open = false;
  }
  function keyDown(event) {
    if (event.key === 'Escape' && picker()?.open) {
      event.preventDefault(); event.stopPropagation(); picker().open = false; picker().querySelector('summary').focus(); return;
    }
    if (!event.target.closest('.notes-list')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault(); event.stopPropagation(); picked = new Set(getNotes().filter(note => !note.deletedAt).map(note => note.id)); paint();
    } else if (event.key === 'Escape' && picked.size) {
      event.preventDefault(); event.stopPropagation(); picked.clear(); paint();
    }
  }
  root.addEventListener('dragstart', dragStart);
  root.addEventListener('dragover', dragOver);
  root.addEventListener('drop', drop);
  root.addEventListener('dragend', finish);
  root.addEventListener('dragleave', dragLeave);
  root.addEventListener('keydown', keyDown);
  root.addEventListener('pointerdown', pointerDown);
  return {
    paint,
    get active() { return dragging.length > 0 || busy; },
    select(event, id) {
      if (event.metaKey || event.ctrlKey) {
        picked.has(id) ? picked.delete(id) : picked.add(id); paint(); return true;
      }
      if (event.shiftKey && picked.size) {
        const ids = getNotes().map(note => note.id); const anchor = ids.indexOf([...picked][0]); const end = ids.indexOf(id);
        picked = new Set(ids.slice(Math.min(anchor, end), Math.max(anchor, end) + 1)); paint(); return true;
      }
      picked.clear(); return false;
    },
    destroy() {
      root.querySelector('#notes-drop-group').removeEventListener('click', groupPicked);
      root.removeEventListener('dragstart', dragStart); root.removeEventListener('dragover', dragOver);
      root.removeEventListener('drop', drop); root.removeEventListener('dragend', finish); root.removeEventListener('dragleave', dragLeave); root.removeEventListener('keydown', keyDown); root.removeEventListener('pointerdown', pointerDown);
    },
  };
}
