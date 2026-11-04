import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml as e } from '../../core/view-helpers.js';
import { floatNoteTools } from './notes-tools-position.js';

const blocks = [
  ['text', 'Text', 'Plain paragraph', (c) => c.setParagraph()],
  ['h1', 'Heading 1', 'Large heading', (c) => c.setHeading({ level: 1 })],
  ['h2', 'Heading 2', 'Medium heading', (c) => c.setHeading({ level: 2 })],
  ['h3', 'Heading 3', 'Small heading', (c) => c.setHeading({ level: 3 })],
  ['bullet', 'Bulleted list', 'A simple list', (c) => c.toggleBulletList()],
  ['number', 'Numbered list', 'An ordered list', (c) => c.toggleOrderedList()],
  ['todo', 'To-do list', 'Track tasks with checkboxes', (c) => c.toggleTaskList()],
  ['quote', 'Quote', 'Highlight a passage', (c) => c.toggleBlockquote()],
  ['code', 'Code block', 'Write a code snippet', (c) => c.toggleCodeBlock()],
  ['divider', 'Divider', 'Separate sections', (c) => c.setHorizontalRule()],
  [
    'table',
    'Table',
    'Three columns with a header',
    (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
  ],
];
const formats = [
  ['bold', 'B', 'Bold · ⌘B'],
  ['italic', 'I', 'Italic · ⌘I'],
  ['underline', 'U', 'Underline · ⌘U'],
  ['strike', 'S', 'Strikethrough'],
  ['code', '&lt;/&gt;', 'Inline code · ⌘E'],
];

/** Contextual controls use the shared UX renderer, preserving the document selection. */
export function createNoteTools({ editor, host, notes, onLink }) {
  let choices = [];
  let active = 0;
  let trigger = null;
  let saved = null;
  let colors = false;
  let floating;
  function hide() {
    host.hidden = true;
    trigger = null;
    floating?.hide();
  }
  floating = floatNoteTools({ host, editor, onHide: hide });
  const position = pos => floating.position(pos);
  function choose(index) {
    const choice = choices[index];
    if (!choice) return;
    const chain = editor.chain().focus().deleteRange(trigger);
    hide();
    choice.apply(chain).run();
  }
  function paintChoices() {
    host.className = 'notes-context-tools notes-command-menu';
    setHtml(
      host,
      `<small>${trigger?.kind === 'wiki' ? 'LINK A NOTE' : 'INSERT A BLOCK'}</small><div role="listbox" aria-label="Suggestions">${choices.map((choice, i) => `<button type="button" role="option" aria-selected="${i === active}" data-note-command="${i}"><b>${e(choice.label)}</b><span>${e(choice.description)}</span></button>`).join('') || '<p>No matches</p>'}</div>`,
    );
    host.querySelectorAll('[data-note-command]').forEach((button) => {
      button.onmousedown = (event) => event.preventDefault();
      button.onclick = () => choose(Number(button.dataset.noteCommand));
    });
  }
  function bubble() {
    host.className = 'notes-context-tools notes-format-toolbar';
    setHtml(
      host,
      `<div role="toolbar" aria-label="Format selection">${formats.map(([id, label, title]) => `<button type="button" data-format="${id}" aria-label="${title}" aria-pressed="${editor.isActive(id)}">${label}</button>`).join('')}<button type="button" data-format="link">Link</button><button type="button" data-format="color">Color</button></div>${colors ? `<div class="notes-color-choices">${['default', 'red', 'orange', 'green', 'blue', 'purple', 'highlight'].map((tone) => `<button type="button" data-tone="${tone}" aria-label="${tone}" class="note-tone-${tone}">${tone === 'highlight' ? 'Highlight' : tone === 'default' ? 'Default' : 'A'}</button>`).join('')}</div>` : ''}`,
    );
    host.querySelectorAll('button').forEach((button) => {
      button.onmousedown = (event) => event.preventDefault();
    });
    host.querySelectorAll('[data-format]').forEach((button) => {
      button.onclick = () => {
        const id = button.dataset.format;
        if (id === 'color') {
          colors = !colors;
          bubble();
          position(saved.from);
          return;
        }
        const range = saved;
        hide();
        if (id === 'link') {
          onLink('', { start: range.from, end: range.to });
          return;
        }
        editor.chain().focus().setTextSelection(range).toggleMark(id).run();
      };
    });
    host.querySelectorAll('[data-tone]').forEach((button) => {
      button.onclick = () => {
        const chain = editor.chain().focus().setTextSelection(saved);
        (button.dataset.tone === 'default'
          ? chain.unsetMark('noteTone')
          : chain.setMark('noteTone', { tone: button.dataset.tone })
        ).run();
        hide();
      };
    });
  }
  function update() {
    if (!editor.isEditable) return hide();
    const { from, to, $from, empty } = editor.state.selection;
    if (!empty) {
      saved = { from, to };
      colors = false;
      trigger = null;
      bubble();
      position(from);
      return;
    }
    const prefix = $from.parent.textBetween(0, $from.parentOffset, '\n', '\ufffc');
    const slash = /^\/([\w ]*)$/.exec(prefix);
    const wiki = /\[\[([^\]\n]{0,80})$/.exec(prefix);
    if (!slash && !wiki) return hide();
    const match = slash || wiki;
    const query = match[1].toLowerCase();
    trigger = { from: from - match[0].length, to, kind: wiki ? 'wiki' : 'slash' };
    choices = wiki
      ? notes()
          .filter((note) => !note.deletedAt && note.title.toLowerCase().includes(query))
          .slice(0, 8)
          .map((note) => ({
            label: note.title,
            description: 'Link to note',
            apply: (c) =>
              c.insertContent({
                type: 'text',
                text: note.title,
                marks: [{ type: 'link', attrs: { href: `habibi://note/${note.id}` } }],
              }),
          }))
      : blocks
          .filter(([id, label]) => `${id} ${label}`.toLowerCase().includes(query))
          .map(([, label, description, apply]) => ({ label, description, apply }));
    active = 0;
    paintChoices();
    position(from);
  }
  return {
    update,
    hide,
    destroy() { hide(); floating.destroy(); },
    handleKey(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        const { from, to } = editor.state.selection;
        onLink('', { start: from, end: to });
        return true;
      }
      if (host.hidden) return false;
      if (event.key === 'Escape') {
        hide();
        return true;
      }
      if (!trigger) return false;
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        active =
          (active + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) %
          Math.max(1, choices.length);
        paintChoices();
        host.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
        return true;
      }
      if (event.key === 'Enter' && choices.length) {
        choose(active);
        return true;
      }
      return false;
    },
  };
}
