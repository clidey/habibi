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
    'a', 'article', 'audio', 'b', 'br', 'button', 'code', 'details', 'div', 'em', 'footer',
    'h2', 'h3', 'header', 'i', 'img', 'input', 'kbd', 'label', 'li', 'ol', 'option', 'p',
    'path', 'pre', 'rect', 'section', 'select', 'small', 'span', 'strong', 'summary', 'svg',
    'textarea', 'time', 'ul', 'video',
  ],
  ALLOWED_ATTR: [
    'alt', 'aria-busy', 'aria-checked', 'aria-controls', 'aria-expanded', 'aria-hidden',
    'aria-label', 'aria-live', 'aria-selected', 'checked', 'class', 'controls', 'd', 'disabled',
    'download', 'draggable', 'fill', 'height', 'hidden', 'href', 'id', 'loading', 'multiple',
    'placeholder', 'preload', 'rel', 'role', 'rows', 'rx', 'selected', 'spellcheck', 'src', 'stroke',
    'stroke-width', 'style', 'target', 'type', 'value', 'viewBox', 'width', 'x', 'y',
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
  element.innerHTML = DOMPurify.sanitize(String(markup ?? ''), config);
  return element;
}

/** Replaces an element with sanitized markup. Use instead of `.outerHTML = …`. */
export function replaceHtml(element, markup) {
  if (!element) return element;
  element.outerHTML = DOMPurify.sanitize(String(markup ?? ''), config);
  return element;
}
