import { Mark, Node } from '@tiptap/core';

export const noteTones = {
  red: '#d85b60',
  orange: '#c78135',
  green: '#458c68',
  blue: '#5388d8',
  purple: '#a36bd1',
  highlight: '#e4c45b55',
};
export const Tone = Mark.create({
  name: 'noteTone',
  addAttributes: () => ({ tone: { default: null } }),
  parseHTML: () => [
    {
      tag: 'span[data-note-tone]',
      getAttrs: (el) =>
        Object.hasOwn(noteTones, el.dataset.noteTone) ? { tone: el.dataset.noteTone } : false,
    },
  ],
  renderHTML: ({ HTMLAttributes }) => [
    'span',
    {
      'data-note-tone': HTMLAttributes.tone,
      style: `${HTMLAttributes.tone === 'highlight' ? 'background-color' : 'color'}:${noteTones[HTMLAttributes.tone] || 'inherit'}`,
    },
    0,
  ],
  renderMarkdown: (node, h) =>
    `<span data-note-tone="${Object.hasOwn(noteTones, node.attrs?.tone) ? node.attrs.tone : 'blue'}">${h.renderChildren(node)}</span>`,
});

/** Preserve Markdown images without contacting remote hosts while editing. */
export const SafeImage = Node.create({
  name: 'image',
  group: 'block',
  inline: false,
  atom: true,
  addAttributes: () => ({ src: { default: '' }, alt: { default: '' }, title: { default: null } }),
  parseHTML: () => [{ tag: 'img' }],
  renderHTML: ({ node }) => [
    'span',
    { class: 'notes-image-placeholder', contenteditable: 'false' },
    `Image: ${node.attrs.alt || 'attachment'}`,
  ],
  markdownTokenName: 'image',
  parseMarkdown: (token) => ({
    type: 'image',
    attrs: { src: token.href, alt: token.text, title: token.title },
  }),
  renderMarkdown: (node) =>
    `![${String(node.attrs.alt || '').replace(/[\\[\]]/g, '\\$&')}](<${String(node.attrs.src || '').replace(/[<>\r\n]/g, encodeURIComponent)}>)`,
});
