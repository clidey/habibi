import { thisDevice } from '../../core/platform-copy.js';
import { setHtml } from '../../core/safe-dom.js';
import { icon, refreshIcons, spinner } from '../../core/view-helpers.js';
import { createNotesDrag } from './notes-drag.js';
import { createNotesSession } from './notes-session.js';
import { notesWorkspaceMarkup, foldersMarkup, notesListMarkup } from './notes-view.js';
import { mountNotesEditor } from './notes-editor.js';
import { folderDialog } from './notes-dialogs.js';
import { sourceReference, markdownLink } from './notes-links.js';
import { copyNoteText, importNotes } from './notes-transfer.js';
import { noteReferences } from './notes-markdown.js';

export function createNotesFeature({ input, defaultView, resultsView, count, notify, onOpen, onReference }) {
  let selected = null; let folder = 'all'; let query = ''; let editor; let loaded = false; let source = null; let listTimer; let listCollapsed = false; let drag;
  const page = () => resultsView.querySelector('.notes-workspace');
  const session = createNotesSession({
    onChange() { if (!page()) return; editor?.refresh(); clearTimeout(listTimer); listTimer = setTimeout(paintList, 180); },
    onStatus: paintStatus,
  });
  const current = () => session.library.notes.find(note => note.id === selected);
  function visibleNotes() {
    const text = query.toLowerCase().trim();
    const order = new Map((session.library.noteOrder || []).map((id, index) => [id, index]));
    return session.library.notes.filter(note => (folder === 'trash' ? Boolean(note.deletedAt) : !note.deletedAt && (folder === 'all' || note.folderId === folder)) && (!source || noteReferences(note, session.library.notes).some(ref => ref.href === source.href)) && `${note.title} ${note.body}`.toLowerCase().includes(text)).sort((a, b) => (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1) || b.updatedAt.localeCompare(a.updatedAt));
  }
  function paintStatus(status = session.getStatus()) {
    const root = page(); if (!root) return;
    const label = root.querySelector('#notes-save-status');
    if (label) label.textContent = status.error ? 'Draft kept · save failed' : status.saving ? 'Saving…' : status.dirty ? 'Unsaved changes' : 'Saved';
    const error = root.querySelector('#notes-save-error');
    if (error) {
      error.hidden = !status.error;
      error.querySelector('span').textContent = status.error?.message || '';
      const retry = error.querySelector('button');
      retry.textContent = status.error?.code === 'conflict' ? 'Copy draft & reload' : 'Retry save';
      retry.onclick = async () => {
        try {
          if (status.error?.code === 'conflict') {
            const note = current(); if (!note) return;
            if (!(await copyNoteText(`# ${note.title}\n\n${note.body}`, notify))) return;
            await session.reload(note.id); paintEditor(); paintSidebar();
          } else await session.flushAll();
        } catch (failure) { notify(failure.message); }
      };
    }
  }
  function paintList() {
    const root = page(); if (!root || drag?.active) return;
    setHtml(root.querySelector('#notes-list'), notesListMarkup(visibleNotes(), selected));
    root.querySelectorAll('[data-note]').forEach(button => { button.onclick = event => { if (!drag?.select(event, button.dataset.note)) select(button.dataset.note, true).catch(error => notify(error.message)); }; });
    drag?.paint(); refreshIcons();
  }
  function paintSidebar() {
    const root = page(); if (!root) return;
    const context = root.querySelector('#notes-source-context'); context.hidden = !source;
    context.querySelector('span').textContent = source?.label || '';
    context.querySelector('button').onclick = () => { source = null; folder = 'all'; paint(); };
    setHtml(root.querySelector('#notes-folders'), foldersMarkup(session.library, folder));
    paintList();
    root.querySelector('#notes-total').textContent = `${session.library.notes.filter(note => !note.deletedAt).length} notes · on ${thisDevice()}`;
    root.querySelectorAll('[data-folder]').forEach(button => { button.onclick = async () => {
      try { if (selected) await session.flush(selected); folder = button.dataset.folder; source = null; selected = visibleNotes()[0]?.id || null; paint(); } catch (error) { notify(error.message); }
    }; });
    root.querySelectorAll('[data-edit-folder]').forEach(button => { button.onclick = () => editFolder(button.dataset.editFolder); });
    root.querySelector('#notes-new-folder').onclick = () => editFolder();
    refreshIcons();
  }
  function paintEditor() {
    const root = page(); if (!root) return;
    editor?.destroy?.();
    editor = mountNotesEditor({ target: root.querySelector('#notes-pane-content'), host: root.querySelector('#notes-dialog-host'), note: current(), session,
      onSelect: select, onCreate: create, onReference: (ref, label) => ref.type === 'workspace' && ref.id === 'notes' ? show() : onReference(ref, label),
      onStructureChange: async refreshSelection => {
        if (refreshSelection && !visibleNotes().some(note => note.id === selected)) selected = visibleNotes()[0]?.id || null;
        paint();
      }, notify,
    });
    paintStatus();
    const toggle = root.querySelector('#notes-toggle-list');
    function updateListVisibility() {
      root.classList.toggle('notes-list-collapsed', listCollapsed);
      if (toggle) {
        toggle.setAttribute('aria-expanded', String(!listCollapsed));
        toggle.setAttribute('aria-label', listCollapsed ? 'Show notes list' : 'Hide notes list');
        toggle.title = listCollapsed ? 'Show notes list' : 'Expand note';
        setHtml(toggle, icon(listCollapsed ? 'collapse' : 'expand'));
        refreshIcons();
      }
    }
    if (toggle) toggle.onclick = () => { listCollapsed = !listCollapsed; updateListVisibility(); };
    updateListVisibility();
  }
  function paint() { paintSidebar(); paintEditor(); }
  async function select(id, focus = false) {
    if (selected) await session.flush(selected);
    const note = session.library.notes.find(item => item.id === id);
    if (!note) return notify('This linked note no longer exists.');
    if (Boolean(note.deletedAt) !== (folder === 'trash')) folder = note.deletedAt ? 'trash' : 'all';
    selected = id; paint();
    if (focus) editor?.body?.focus();
  }
  async function create(title = '', body = '') {
    if (drag?.active) return;
    const root = page();
    if (root) { root.querySelector('#notes-new').disabled = true; root.querySelector('#notes-pane-content').inert = true; }
    try {
      await session.flushAll();
      if (source && !body) body = `${markdownLink(source.label || 'Linked item', source.href)}\n\n`;
      const note = await session.create({ title: title || 'Untitled', body, folderId: session.library.folders.some(item => item.id === folder) ? folder : null });
      if (!page()) return;
      if (folder === 'trash') folder = 'all';
      query = ''; input.value = ''; selected = note.id; paint(); editor?.title?.focus();
    } catch (error) { notify(error.message); }
    finally { if (root?.isConnected) { root.querySelector('#notes-new').disabled = false; root.querySelector('#notes-pane-content').inert = false; } }
  }
  function editFolder(id) {
    const parentId = session.library.folders.some(item => item.id === folder) ? folder : null;
    folderDialog(page().querySelector('#notes-dialog-host'), session.library.folders, id,
      async name => { const result = await session.folder(id ? 'PATCH' : 'POST', id ? { name } : { name, parentId }, id); folder = result.folder.id; source = null; if (!visibleNotes().some(note => note.id === selected)) selected = visibleNotes()[0]?.id || null; paint(); },
      async () => { await session.folder('DELETE', undefined, id); folder = 'all'; paint(); });
  }
  async function show(options = {}) {
    drag?.destroy();
    onOpen(); input.value = ''; query = ''; source = null;
    defaultView.classList.add('hidden'); resultsView.classList.remove('hidden');
    count.textContent = `Notes · on ${thisDevice()}`; input.placeholder = 'Search notes, or press Enter to create one…';
    setHtml(resultsView, notesWorkspaceMarkup());
    const root = page();
    setHtml(root.querySelector('#notes-pane-content'), `<div class="loading-state">${spinner()} Loading notes on ${thisDevice()}…</div>`);
    try {
      if (!loaded) { await session.load(); loaded = true; }
      if (!root.isConnected) return;
      if (options.source) {
        const ref = sourceReference(options.source);
        if (ref) { source = { ...ref, label: String(options.source.title || 'Linked item').slice(0, 200) }; folder = 'all'; }
        if (source && !visibleNotes().length) {
          const note = await session.create({ title: source.label, body: `${markdownLink(source.label, source.href)}\n\n` }); selected = note.id;
        }
      }
      if (options.noteId) { folder = session.library.notes.find(note => note.id === options.noteId)?.deletedAt ? 'trash' : 'all'; selected = options.noteId; }
      if (!selected || !visibleNotes().some(note => note.id === selected)) selected = visibleNotes()[0]?.id || null;
      root.querySelector('#notes-new').onclick = () => create();
      root.querySelector('#notes-import').onclick = () => root.querySelector('#notes-import-files').click();
      root.querySelector('#notes-import-files').onchange = async event => {
        try {
          await session.flushAll();
          const notes = await importNotes(event.target.files, session, session.library.folders.some(item => item.id === folder) ? folder : null, notify);
          if (notes.length) { source = null; folder = 'all'; selected = notes[0].id; paint(); }
        } catch (error) { notify(error.message); }
        event.target.value = '';
      };
      drag = createNotesDrag({ root, session, getNotes: visibleNotes, getFolder: () => folder, notify,
        onOrganized: async change => {
          if (change.folderId === undefined) { paintSidebar(); paintStatus(); return; }
          folder = change.folderId || 'all'; selected = change.noteId; query = ''; input.value = ''; source = null;
          paint();
        },
      });
      root.onkeydown = event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); input.focus(); input.select(); return; } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); create(); } };
      if (!selected && folder !== 'trash') { const note = await session.create({ title: 'Untitled', body: '', folderId: folder === 'all' ? null : folder }); selected = note.id; }
      paint(); editor?.body?.focus();
    } catch (error) {
      if (!root.isConnected) return;
      setHtml(root.querySelector('#notes-pane-content'), '<div class="notes-empty"><h2>Could not open Notes</h2><p></p><button type="button" class="secondary" id="notes-retry">Try again</button></div>');
      root.querySelector('.notes-empty p').textContent = error.message;
      root.querySelector('#notes-retry').onclick = () => show(options);
    }
  }
  function filter(value) { query = value; source = null; if (page()) paintSidebar(); }
  function handleKey(event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); create(); return true; }
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      const notes = visibleNotes(); if (notes.length) select(notes[0].id, true).catch(error => notify(error.message)); else create(input.value.trim());
      return true;
    }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); const notes = visibleNotes(); const index = notes.findIndex(note => note.id === selected);
      if (notes.length) select(notes[(index + (event.key === 'ArrowDown' ? 1 : -1) + notes.length) % notes.length].id).catch(error => notify(error.message));
      return true;
    }
    return false;
  }
  return { show, filter, handleKey, capture: source => show({ source }) };
}
