/** Keep editor tools outside scrolling ancestors, anchored to the visible caret. */
export function floatNoteTools({ host, editor, onHide }) {
  const scrollArea = editor.view.dom.closest('.notes-editor-scroll');
  const workspace = editor.view.dom.closest('.notes-workspace');
  let anchor = null;
  document.body.append(host);
  function position(pos = anchor) {
    if (pos === null) return;
    anchor = pos;
    const caret = editor.view.coordsAtPos(pos);
    const area = (scrollArea || editor.view.dom).getBoundingClientRect();
    const frame = workspace?.getBoundingClientRect();
    const top = Math.max(8, frame?.top ?? 8);
    const bottom = Math.min(window.innerHeight - 8, frame?.bottom ?? window.innerHeight - 8);
    if (caret.bottom < Math.max(top, area.top) || caret.top > Math.min(bottom, area.bottom)) {
      host.hidden = true;
      return;
    }
    const above = Math.max(0, caret.top - top - 8);
    const below = Math.max(0, bottom - caret.bottom - 8);
    host.hidden = false;
    host.style.maxHeight = `${Math.max(above, below)}px`;
    const desiredHeight = host.scrollHeight;
    const useAbove = desiredHeight > below && above > below;
    host.style.maxHeight = `${useAbove ? above : below}px`;
    const size = host.getBoundingClientRect();
    host.dataset.side = useAbove ? 'top' : 'bottom';
    host.style.left = `${Math.max(8, Math.min(caret.left, window.innerWidth - size.width - 8))}px`;
    host.style.top = `${Math.max(top, useAbove ? caret.top - size.height - 8 : caret.bottom + 8)}px`;
  }
  function reposition(event) {
    if (anchor !== null && (event.type === 'resize' || !host.contains(event.target))) position();
  }
  function dismiss(event) {
    if (!host.contains(event.target) && !editor.view.dom.contains(event.target)) onHide();
  }
  document.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  document.addEventListener('pointerdown', dismiss);
  return {
    position,
    hide() { anchor = null; host.hidden = true; },
    destroy() {
      document.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('pointerdown', dismiss);
      host.remove();
    },
  };
}
