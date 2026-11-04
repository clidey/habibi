import DOMPurify from 'dompurify';

// Defence in depth for the launcher's ~90 innerHTML assignments. Every value
// interpolated into that markup is already escaped at the source, but escaping
// only protects the sites a developer remembered; this pass protects the sink
// itself, so a future template that forgets escapeHtml cannot execute script.
//
// The allowlist is the markup the launcher actually builds. Event-handler
// attributes are absent by design: the CSP blocks inline handlers too, so this
// is the second of two independent barriers.
const config = {
  ALLOWED_TAGS: [
    'a',
    'article',
    'aside',
    'audio',
    'b',
    'br',
    'button',
    'circle',
    'code',
    'details',
    'div',
    'em',
    'footer',
    'h2',
    'h3',
    'header',
    'i',
    'img',
    'input',
    'kbd',
    'label',
    'li',
    'nav',
    'ol',
    'option',
    'output',
    'p',
    'path',
    'pre',
    'rect',
    'section',
    'select',
    'small',
    'span',
    'strong',
    'summary',
    'svg',
    'table',
    'tbody',
    'td',
    'textarea',
    'th',
    'thead',
    'time',
    'tr',
    'ul',
    'video',
  ],
  ALLOWED_ATTR: [
    'alt',
    'aria-busy',
    'aria-checked',
    'aria-controls',
    'aria-expanded',
    'aria-hidden',
    'aria-label',
    'aria-live',
    'aria-selected',
    'checked',
    'class',
    'controls',
    'cx',
    'cy',
    'd',
    'disabled',
    'download',
    'draggable',
    'fill',
    'for',
    'focusable',
    'height',
    'hidden',
    'href',
    'id',
    'loading',
    'max',
    'maxlength',
    'min',
    'multiple',
    'placeholder',
    'pathLength',
    'preload',
    'rel',
    'role',
    'r',
    'rows',
    'rx',
    'selected',
    'spellcheck',
    'src',
    'stroke',
    'step',
    'tabindex',
    'title',
    'stroke-width',
    'style',
    'target',
    'type',
    'value',
    'viewBox',
    'width',
    'x',
    'y',
  ],
  // The launcher reads state back out of data-* attributes, so they must survive.
  ALLOW_DATA_ATTR: true,
  ALLOW_ARIA_ATTR: true,
  // Keep <use>/<foreignObject> style escapes out of the inline SVG icons.
  FORBID_TAGS: ['use', 'foreignObject', 'script', 'style', 'iframe', 'object', 'embed'],
};

/** Assigns sanitized markup to an element. Use instead of `.innerHTML = …`. */
export function setHtml(element, markup) {
  if (!element) return element;
  const sanitized = DOMPurify.sanitize(String(markup ?? ''), config);
  element.innerHTML = window.HabibiUx?.renderControls?.(sanitized) || sanitized;
  return element;
}

/** Replaces an element with sanitized markup. Use instead of `.outerHTML = …`. */
export function replaceHtml(element, markup) {
  if (!element) return element;
  const sanitized = DOMPurify.sanitize(String(markup ?? ''), config);
  element.outerHTML = window.HabibiUx?.renderControls?.(sanitized) || sanitized;
  return element;
}

/** Build a standalone UX button for views that insert controls after rendering. */
export function createUxButton(className, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  const host = document.createElement('span');
  setHtml(host, button.outerHTML);
  return host.firstElementChild;
}
