/** Table actions retain the editor's current cell selection when a control takes focus. */
export function createNoteTableTools(editor, element) {
  const host = document.createElement('div');
  host.className = 'notes-table-tools';
  host.hidden = true;
  element.before(host);
  const commands = new Set(['addRowBefore', 'addRowAfter', 'addColumnBefore', 'addColumnAfter', 'deleteRow', 'deleteColumn', 'deleteTable']);
  const mounted = window.HabibiUx?.mountNoteTableTools?.(host, command => {
    if (!editor.isEditable || !editor.isActive('table') || !commands.has(command)) return;
    editor.chain()[command]().scrollIntoView().run();
    normalizeTableHeader(editor);
    editor.view.focus();
    update();
  });
  function update() { host.hidden = !mounted || !editor.isEditable || !editor.isActive('table'); }
  return { update, destroy() { mounted?.unmount(); host.remove(); } };
}

/** GFM tables have one header row; keep edits stable when saved back to Markdown. */
export function normalizeTableHeader(editor) {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name !== 'table') continue;
    const table = $from.node(depth);
    const start = $from.before(depth);
    const tr = editor.state.tr;
    table.forEach((row, rowOffset, rowIndex) => row.forEach((cell, cellOffset) => {
      const type = editor.schema.nodes[rowIndex === 0 ? 'tableHeader' : 'tableCell'];
      if (cell.type !== type) tr.setNodeMarkup(start + rowOffset + cellOffset + 2, type, cell.attrs);
    }));
    if (tr.docChanged) editor.view.dispatch(tr);
    break;
  }
}
