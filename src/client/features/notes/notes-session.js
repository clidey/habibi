const draftKey = 'habibi.notes.drafts.v1';
export async function notesRequest(path = '', method = 'GET', value) {
  const response = await fetch(`/api/notes${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const data = await response.json();
  if (!data.ok) { const error = new Error(data.error || 'Could not access your notes.'); error.code = data.code; throw error; }
  return data;
}

/** Drafts are captured immediately; only confirmed saves advance the server revision. */
export function createNotesSession({ onChange, onStatus }) {
  const library = { notes: [], folders: [] };
  const dirty = new Map(); const chains = new Map(); const revisions = new Map();
  let timer; let failure = null;
  const emit = () => onStatus({ dirty: dirty.size, saving: chains.size > 0, error: failure });
  function persist() {
    try { localStorage.setItem(draftKey, JSON.stringify([...dirty].map(([id, patch]) => ({ id, revision: revisions.get(id), title: library.notes.find(note => note.id === id)?.title, patch })))); } catch { /* The file store remains authoritative. */ }
  }
  function edit(id, patch) {
    const note = library.notes.find(item => item.id === id);
    if (!note || note.deletedAt) return;
    Object.assign(note, patch);
    dirty.set(id, { ...(dirty.get(id) || {}), ...patch });
    persist(); emit(); onChange(note);
    clearTimeout(timer);
    timer = setTimeout(() => flushAll().catch(() => {}), 450);
  }
  async function flush(id) {
    if (chains.has(id)) return chains.get(id);
    if (!dirty.has(id)) return;
    const promise = (async () => {
      while (dirty.has(id)) {
        const patch = dirty.get(id);
        try {
          const result = await notesRequest(`/${id}`, 'PATCH', { ...patch, revision: revisions.get(id) });
          revisions.set(id, result.note.revision);
          if (dirty.get(id) === patch) dirty.delete(id);
          const note = library.notes.find(item => item.id === id);
          Object.assign(note, result.note, dirty.get(id) || {});
          failure = null; persist(); onChange(note);
        } catch (error) { failure = error; persist(); throw error; }
      }
    })();
    chains.set(id, promise); emit();
    try { await promise; } finally { chains.delete(id); emit(); }
  }
  async function flushAll() { clearTimeout(timer); await Promise.all([...dirty.keys()].map(flush)); }
  async function load() {
    if (dirty.size) await flushAll();
    const data = await notesRequest();
    library.notes = data.notes; library.folders = data.folders; library.noteOrder = data.noteOrder;
    for (const note of library.notes) revisions.set(note.id, note.revision);
    let drafts = [];
    try { drafts = JSON.parse(localStorage.getItem(draftKey) || '[]'); } catch { /* Ignore malformed browser state. */ }
    if (Array.isArray(drafts)) for (const draft of drafts) {
      const note = library.notes.find(item => item.id === draft.id);
      if (!draft.patch || typeof draft.patch !== 'object') continue;
      const patch = {};
      if (typeof draft.patch.body === 'string' && draft.patch.body.length <= 262144) patch.body = draft.patch.body;
      if (typeof draft.patch.title === 'string' && draft.patch.title.length <= 200) patch.title = draft.patch.title;
      if (typeof draft.patch.icon === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(draft.patch.icon)) patch.icon = draft.patch.icon;
      if (typeof draft.patch.emoji === 'string' && draft.patch.emoji.length <= 16) patch.emoji = draft.patch.emoji;
      if (draft.patch.folderId === null || library.folders.some(folder => folder.id === draft.patch.folderId)) patch.folderId = draft.patch.folderId;
      if (!Object.keys(patch).length) continue;
      if (!note || note.deletedAt) {
        const recovered = await create({ title: `Recovered: ${patch.title || draft.title || note?.title || 'Untitled'}`.slice(0, 200), body: patch.body ?? note?.body ?? '', emoji: patch.emoji || note?.emoji || '📝', ...(patch.icon || note?.icon ? { icon: patch.icon || note.icon } : {}), folderId: patch.folderId ?? null });
        onChange(recovered); continue;
      }
      if (Object.entries(patch).every(([key, value]) => note[key] === value)) continue;
      Object.assign(note, patch); dirty.set(note.id, patch);
      if (draft.revision !== note.revision) {
        revisions.set(note.id, draft.revision);
        failure = new Error('A recovered draft conflicts with a newer note. Copy your draft before reloading.'); failure.code = 'conflict';
      }
    }
    persist(); emit();
    if (dirty.size && !failure) timer = setTimeout(() => flushAll().catch(() => {}), 450);
    return library;
  }
  async function create(value) {
    const { note } = await notesRequest('', 'POST', value);
    library.notes.unshift(note); library.noteOrder?.unshift(note.id); revisions.set(note.id, note.revision); return note;
  }
  async function trash(id, restore = false) {
    await flush(id);
    const data = await notesRequest(`/${id}${restore ? '/restore' : ''}`, restore ? 'POST' : 'DELETE', { revision: revisions.get(id) });
    Object.assign(library.notes.find(note => note.id === id), data.note); revisions.set(id, data.note.revision); return data.note;
  }
  async function folder(action, value, id = '') {
    await flushAll();
    const result = await notesRequest(`/folders${id ? `/${id}` : ''}`, action, value);
    if (action === 'POST') library.folders.push(result.folder);
    else if (action === 'PATCH') Object.assign(library.folders.find(folder => folder.id === id), result.folder);
    else { library.notes = result.notes; library.folders = result.folders; for (const note of library.notes) revisions.set(note.id, note.revision); }
    return result;
  }
  async function organize(ids, value) {
    await flushAll();
    const notes = ids.map(id => ({ id, revision: revisions.get(id) }));
    const data = await notesRequest('/organize', 'POST', { ...value, notes });
    const current = new Map(library.notes.map(note => [note.id, note]));
    library.notes = data.notes.map(saved => Object.assign(current.get(saved.id) || {}, saved));
    library.folders = data.folders; library.noteOrder = data.noteOrder;
    for (const note of library.notes) revisions.set(note.id, note.revision);
    onChange(); return data;
  }
  async function reload(id) {
    const data = await notesRequest();
    const saved = data.notes.find(note => note.id === id);
    if (!saved) throw new Error('This note no longer exists.');
    Object.assign(library.notes.find(note => note.id === id), saved);
    revisions.set(id, saved.revision); dirty.delete(id); failure = null; persist(); emit();
  }
  window.addEventListener('pagehide', () => {
    persist();
    for (const [id, patch] of dirty) {
      if (chains.has(id)) continue;
      fetch(`/api/notes/${id}`, { method: 'PATCH', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...patch, revision: revisions.get(id) }) }).catch(() => {});
    }
  });
  return { library, load, edit, flush, flushAll, create, trash, folder, organize, reload, getStatus: () => ({ dirty: dirty.size, saving: chains.size > 0, error: failure }) };
}
