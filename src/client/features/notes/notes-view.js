export { notePreview } from './note-preview.js';
import { notePreview } from './note-preview.js';
import { noteIconName } from './note-icons.js';
import { escapeHtml as e, icon } from '../../core/view-helpers.js';
import { noteReferences } from './notes-markdown.js';
import { quickCopyItems } from './notes-links.js';

export const noteTitle = note => note.title || 'Untitled';
export function relativeTime(value) {
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  return seconds < 60 ? 'just now' : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
}
export function notesWorkspaceMarkup() {
  return `<section class="notes-workspace" aria-label="Notes">
    <aside class="notes-sidebar"><header class="notes-heading"><h2>Notes</h2><button type="button" class="notes-icon-button" id="notes-new" aria-label="New note" title="New note · ⌘ N">${icon('plus')}</button></header>
      <div class="notes-source-context" id="notes-source-context" hidden><small>LINKED NOTES</small><span></span><button type="button" class="notes-text-button">Show all notes</button></div><div class="notes-library-nav" id="notes-folders"></div><div class="notes-list" id="notes-list" aria-label="Notes list"></div><div id="notes-drag-hint" class="notes-drag-hint" role="status" hidden></div><button type="button" class="notes-drop-group notes-folder" id="notes-drop-group" hidden>${icon('folder')}<span id="notes-drop-group-label">Group selected pages</span></button><div class="notes-sidebar-footer"><span id="notes-total" class="sr-only"></span><button type="button" class="notes-text-button" id="notes-import">Import .md</button><input type="file" id="notes-import-files" accept=".md,.markdown,text/markdown,text/plain" multiple hidden /></div></aside>
    <section class="notes-pane"><div id="notes-pane-content"></div></section><div id="notes-dialog-host"></div>
  </section>`;
}
export function folderTreeMarkup(folders, active, notes, parent = null, depth = 0) {
  return folders.filter(folder => folder.parentId === parent).sort((a, b) => a.name.localeCompare(b.name)).map(folder => `<div class="notes-folder-row" style="--folder-depth:${depth}"><button type="button" class="notes-folder ${active === folder.id ? 'selected' : ''}" data-folder="${e(folder.id)}">${icon('folder')}<span>${e(folder.name)}</span><small>${notes.filter(note => !note.deletedAt && note.folderId === folder.id).length}</small></button><button type="button" class="notes-folder-menu notes-icon-button" data-edit-folder="${e(folder.id)}" aria-label="Edit folder ${e(folder.name)}">${icon('more-horizontal')}</button></div>${folderTreeMarkup(folders, active, notes, folder.id, depth + 1)}`).join('');
}
export function foldersMarkup(library, active) {
  const label = active === 'trash' ? 'Trash' : library.folders.find(folder => folder.id === active)?.name || 'All notes';
  return `<details class="notes-collection-picker"><summary>${e(label)}${icon('chevron-down')}</summary><div class="notes-collection-options"><button type="button" class="notes-folder ${active === 'all' ? 'selected' : ''}" data-folder="all">${icon('files')}<span>All notes</span><small>${library.notes.filter(note => !note.deletedAt).length}</small></button><div class="notes-folder-section"><span>Folders</span><button type="button" class="notes-icon-button" id="notes-new-folder" aria-label="New folder">${icon('plus')}</button></div><div class="notes-folder-tree">${folderTreeMarkup(library.folders, active, library.notes)}</div><button type="button" class="notes-folder ${active === 'trash' ? 'selected' : ''}" data-folder="trash">${icon('trash-2')}<span>Trash</span><small>${library.notes.filter(note => note.deletedAt).length}</small></button></div></details>`;
}
export function notesListMarkup(notes, selected) {
  if (!notes.length) return '<div class="notes-list-empty">No notes here.<br>Create one with the + button.</div>';
  return notes.map(note => `<button type="button" class="notes-list-item ${selected === note.id ? 'selected' : ''}" data-note="${e(note.id)}"><span class="notes-list-icon" aria-hidden="true">${icon(noteIconName(note))}</span><span><b>${e(noteTitle(note))}</b><small>${e(notePreview(note))}</small></span></button>`).join('');
}
export function noteEditorMarkup(note, folders) {
  if (!note) return `<div class="notes-toolbar"><button type="button" class="notes-icon-button" id="notes-toggle-list" aria-label="Hide notes list" aria-expanded="true" title="Expand note">${icon('expand')}</button></div><div class="notes-empty"><span class="icon">${icon('files')}</span><h2>Your thoughts, connected.</h2><p>Create a note, organize it in a folder, and link it to conversations or other notes.</p><button type="button" class="primary" id="notes-empty-create">Create a note</button></div>`;
  return `<div class="notes-toolbar"><button type="button" class="notes-icon-button" id="notes-toggle-list" aria-label="Hide notes list" aria-expanded="true" title="Expand note">${icon('expand')}</button><div class="notes-toolbar-actions"><span id="notes-save-status" role="status">Saved</span><div id="note-page-menu"></div></div></div>
    <div class="notes-save-error" id="notes-save-error" hidden><span></span><button type="button" id="notes-save-retry">Retry save</button></div>
    <div class="notes-editor-scroll"><div class="notes-document"><div class="notes-note-heading"><div id="note-icon-picker"></div><input id="note-title" aria-label="Note title" placeholder="Untitled" maxlength="200" value="${e(note.title === 'Untitled' ? '' : note.title)}" ${note.deletedAt ? 'disabled' : ''} /></div>
    ${note.folderId ? `<div class="notes-editor-meta">${icon('folder')} ${e(folders.find(folder => folder.id === note.folderId)?.name || '')}</div>` : ''}
    ${note.deletedAt ? '<div class="notes-trash-notice">This note is in Trash. Restore it from the page menu to make changes.</div>' : ''}
    <div class="notes-writing-area"><div id="note-rich-editor" class="notes-markdown"></div><div id="note-context-tools" class="notes-context-tools" hidden></div></div>
    <div id="note-connections"></div></div></div>`;
}

const referenceButton = (ref, notes) => {
  const target = ref.type === 'note' ? notes.find(note => note.id === ref.id) : null;
  const label = target ? noteTitle(target) : ref.label || ref.type;
  return `<button type="button" class="notes-reference" data-note-reference="${e(ref.href)}" data-reference-label="${e(label)}">${icon(target ? noteIconName(target) : ref.type === 'mail' ? 'mail' : ref.type === 'whatsapp' ? 'whatsapp' : ref.type === 'note' ? 'files' : 'link')}<span>${e(label)}</span>${target?.deletedAt ? '<small>Trash</small>' : ''}</button>`;
};
export function connectionsMarkup(note, notes) {
  const outgoing = noteReferences(note, notes);
  const incoming = notes.filter(other => other.id !== note.id && !other.deletedAt && noteReferences(other, notes).some(ref => ref.type === 'note' && ref.id === note.id));
  const quick = quickCopyItems(note.body);
  if (!outgoing.length && !incoming.length && !quick.length) return '';
  return `<details class="notes-connections"><summary>Connections${outgoing.length + incoming.length ? ` · ${outgoing.length + incoming.length}` : ''}</summary>${outgoing.length ? `<div class="notes-connection-row"><span>Links to</span><div>${outgoing.map(ref => referenceButton(ref, notes)).join('')}</div></div>` : ''}${incoming.length ? `<div class="notes-connection-row"><span>Linked from</span><div>${incoming.map(other => referenceButton({ type: 'note', id: other.id, href: `habibi://note/${other.id}` }, notes)).join('')}</div></div>` : ''}${quick.length ? `<h3>Quick copy</h3><div class="notes-quick-copy">${quick.map((item, index) => `<button type="button" data-quick-copy="${index}"><small>${e(item.type)}</small><span>${e(item.value.slice(0, 100))}</span>${icon('copy')}</button>`).join('')}</div>` : ''}</details>`;
}
