import { createNoteTableTools } from './notes-table-tools.js';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import { createNoteTools } from './notes-rich-tools.js';
import { Tone, SafeImage } from './notes-rich-extensions.js';
import { parseNoteReference } from './notes-links.js';

/** The document engine owns selection and undo; Markdown remains the saved format. */
export function createRichNoteEditor({
  element,
  toolsHost,
  body,
  editable,
  notes,
  onChange,
  onLink,
  onOpen,
}) {
  let tools;
  let tableTools;
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          protocols: ['habibi'],
          isAllowedUri: (value) => Boolean(parseNoteReference(value)),
        },
      }),
      Markdown,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit,
      Tone,
      SafeImage,
    ],
    content: body,
    contentType: 'markdown',
    editable,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': 'Note content',
        'aria-multiline': 'true',
        'data-placeholder': 'Start writing. Type / for commands or [[ to link a note…',
      },
      handleKeyDown: (_view, event) => tools?.handleKey(event) || false,
      handleClick: (_view, _pos, event) => {
        const link = event.target.closest('a[href]');
        if (link && (event.metaKey || event.ctrlKey || !editable)) {
          event.preventDefault();
          onOpen(link.getAttribute('href'), link.textContent);
          return true;
        }
        return false;
      },
    },
    onUpdate: () => {
      onChange(editor.getMarkdown());
      tableTools?.update();
      tools?.update();
    },
    onSelectionUpdate: () => { tableTools?.update(); tools?.update(); },
    onBlur: () => {
      setTimeout(() => {
        if (!toolsHost.contains(document.activeElement)) tools?.hide();
      }, 120);
    },
  });
  tools = createNoteTools({ editor, host: toolsHost, notes, onLink });
  tableTools = createNoteTableTools(editor, element);
  tableTools.update();
  let destroyed = false;
  const observer = new MutationObserver(() => {
    if (!element.isConnected) destroy();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    observer.disconnect();
    tools.destroy();
    tableTools.destroy();
    editor.destroy();
  }
  return {
    editor,
    focus: () => editor.commands.focus(),
    selection: () => ({ start: editor.state.selection.from, end: editor.state.selection.to }),
    insert(text, range) {
      const from = range?.start ?? editor.state.selection.from;
      const to = range?.end ?? editor.state.selection.to;
      editor.chain().focus().insertContentAt({ from, to }, text, { contentType: 'markdown' }).run();
    },
    destroy,
  };
}
