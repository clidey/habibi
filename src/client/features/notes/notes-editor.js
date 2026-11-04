import { noteIconName } from './note-icons.js';
import { setHtml } from '../../core/safe-dom.js';
import { refreshIcons } from '../../core/view-helpers.js';
import { noteEditorMarkup, connectionsMarkup } from './notes-view.js';
import { createRichNoteEditor } from './notes-rich-editor.js';
import { parseNoteReference, quickCopyItems } from './notes-links.js';
import { moveDialog } from './notes-dialogs.js';
import { openNotesLinkPicker } from './notes-link-picker.js';
import { copyNoteText, exportNote } from './notes-transfer.js';

export function mountNotesEditor({ target, host, note, session, onSelect, onCreate, onReference, onStructureChange, notify }) {
  setHtml(target, noteEditorMarkup(note, session.library.folders));
  if (!note) { target.querySelector('#notes-empty-create').onclick = () => onCreate(); refreshIcons(); return { refresh() {} }; }
  const title = target.querySelector('#note-title');
  const connections = target.querySelector('#note-connections');
  const rich = createRichNoteEditor({ element: target.querySelector('#note-rich-editor'), toolsHost: target.querySelector('#note-context-tools'), body: note.body, editable: !note.deletedAt, notes: () => session.library.notes.filter(item => item.id !== note.id), onChange: value => { session.edit(note.id, { body: value }); refresh(); }, onLink: link, onOpen: openReference });
  const body = { focus: () => rich.focus() };
  let timer;
  function paint() {
    if (!target.isConnected) return;
    const connectionsOpen = connections.querySelector('details')?.open || false;
    setHtml(connections, connectionsMarkup(note, session.library.notes));
    if (connectionsOpen && connections.querySelector('details')) connections.querySelector('details').open = true;
    connections.querySelectorAll('[data-note-reference]').forEach(button => { button.onclick = () => openReference(button.dataset.noteReference, button.dataset.referenceLabel); });
    connections.querySelectorAll('[data-quick-copy]').forEach(button => { button.onclick = () => copyNoteText(quickCopyItems(note.body)[Number(button.dataset.quickCopy)].value, notify); });
    refreshIcons();
  }
  function refresh() { clearTimeout(timer); timer = setTimeout(paint, 160); }
  function insert(text, range) {
    rich.insert(text, range);
  }
  function link(query = '', range) {
    if (note.deletedAt) return;
    const selection = range || rich.selection();
    openNotesLinkPicker({ host, library: session.library, currentId: note.id, query, onInsert: text => insert(text, selection) });
  }
  async function openReference(href, label) {
    const ref = parseNoteReference(href);
    if (!ref) return;
    try { await session.flush(note.id); if (ref.type === 'note') await onSelect(ref.id); else await onReference(ref, label); }
    catch (error) { notify(error.message); }
  }
  title.oninput = () => { session.edit(note.id, { title: title.value || 'Untitled' }); };
  title.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); body.focus(); } };
  const iconPicker = window.HabibiUx.mountNoteIconPicker(target.querySelector('#note-icon-picker'), noteIconName(note), Boolean(note.deletedAt), icon => session.edit(note.id, { icon }));
  const menu = window.HabibiUx.mountNotesPageMenu(target.querySelector('#note-page-menu'), [
    { label: 'Insert link…', disabled: Boolean(note.deletedAt), action: () => link() },
    { label: 'Move to folder…', disabled: Boolean(note.deletedAt), action: () => moveDialog(host, session.library.folders, note.folderId, async folderId => {
      session.edit(note.id, { folderId });
      try { await session.flush(note.id); onStructureChange(); } catch (error) { notify(error.message); }
    }) },
    { label: 'Copy note', action: () => copyNoteText(note.body, notify) },
    { label: 'Export Markdown…', action: () => exportNote(note, notify) },
    { label: 'Undo', disabled: Boolean(note.deletedAt), action: () => rich.editor.chain().focus().undo().run() },
    { label: 'Redo', disabled: Boolean(note.deletedAt), action: () => rich.editor.chain().focus().redo().run() },
    { label: note.deletedAt ? 'Restore note' : 'Move to Trash', danger: !note.deletedAt, action: async () => {
      try { await session.trash(note.id, Boolean(note.deletedAt)); await onStructureChange(true); } catch (error) { notify(error.message); }
    } },
  ]);
  paint();
  return { refresh, body, title, destroy() { clearTimeout(timer); iconPicker.unmount(); menu.unmount(); rich.destroy(); } };
}
