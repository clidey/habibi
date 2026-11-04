const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('rich Notes preserves Markdown structure, local links, colors and image references without loading images', async () => {
  const dom = new JSDOM('<main id="notes-pane-content"><div id="editor"></div><div id="tools" hidden></div></main>', {
    url: 'http://127.0.0.1:4173',
    pretendToBeVisual: true,
  });
  for (const name of [
    'window',
    'document',
    'Node',
    'Element',
    'HTMLElement',
    'MutationObserver',
    'DOMParser',
    'getComputedStyle',
  ])
    global[name] = dom.window[name];
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  global.cancelAnimationFrame = clearTimeout;
  const { createRichNoteEditor } =
    await import('../src/client/features/notes/notes-rich-editor.js');
  const mount = (body) => {
    if (!document.querySelector('#tools')) {
      const tools = document.createElement('div'); tools.id = 'tools'; tools.hidden = true; document.querySelector('main').append(tools);
    }
    return createRichNoteEditor({
      element: document.querySelector('#editor'),
      toolsHost: document.querySelector('#tools'),
      body,
      editable: true,
      notes: () => [],
      onChange() {},
      onLink() {},
      onOpen() {},
    });
  };
  const body =
    '# Heading\n\n**Bold** and [Note](habibi://note/12345678-1234-4234-8234-123456789012)\n\n- [x] Done\n\n| A | B |\n| --- | --- |\n| One | Two |\n\n![private](https://example.com/tracker.png)';
  let rich = mount(body);
  assert.ok(document.querySelector('h1,strong,table'));
  assert.equal(document.querySelector('#tools').parentElement, document.body);
  assert.equal(document.querySelectorAll('img').length, 0);
  assert.match(rich.editor.getMarkdown(), /tracker\.png/);
  assert.match(rich.editor.getMarkdown(), /habibi:\/\/note\//);
  const { normalizeTableHeader } = await import('../src/client/features/notes/notes-table-tools.js');
  let headerPosition;
  rich.editor.state.doc.descendants((node, position) => {
    if (node.type.name === 'tableHeader' && headerPosition === undefined) headerPosition = position;
  });
  rich.editor.commands.setTextSelection(headerPosition + 2);
  rich.editor.commands.addRowBefore();
  normalizeTableHeader(rich.editor);
  const rowCount = document.querySelectorAll('table tr').length;
  assert.equal(rowCount, 3);
  rich.editor.commands.setContent(rich.editor.getMarkdown(), { contentType: 'markdown' });
  assert.equal(document.querySelectorAll('table tr').length, rowCount, 'inserting above the header must not add a row on reload');
  rich.editor.view.coordsAtPos = () => ({ left: 0, bottom: 0 });
  rich.editor
    .chain()
    .setTextSelection({ from: 1, to: 4 })
    .setMark('noteTone', { tone: 'red' })
    .run();
  const saved = rich.editor.getMarkdown();
  assert.match(saved, /data-note-tone="red"/);
  rich.destroy();
  assert.equal(document.querySelector('#tools'), null, 'destroy removes the floating tools');
  rich = mount(saved);
  assert.equal(document.querySelector('[data-note-tone="red"]').textContent, 'Hea');
  assert.ok(document.querySelector('table'));
  assert.equal(document.querySelectorAll('img,script,[onerror]').length, 0);
  rich.destroy();
  dom.window.close();
});
