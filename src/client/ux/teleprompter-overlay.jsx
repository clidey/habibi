import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Button } from '@clidey/ux';
import { UxGlyph } from './glyph.jsx';

function TeleprompterOverlay({ value, onAction }) {
  const status =
    value.error ||
    (value.state === 'running'
      ? value.mode === 'voice'
        ? 'Listening…'
        : `${Math.round(value.pace || 140)} wpm`
      : value.state === 'finished'
        ? 'End of script'
        : 'Paused');
  const script = value.script || '';
  const read = Math.max(0, Math.min(script.length, value.read || 0));
  return (
    <main className="prompter-surface" style={{ paddingTop: `${value.inset || 0}px` }}>
      <header className="prompter-toolbar">
        <span className="prompter-status" role="status">
          {status}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Restart script"
          title="Restart script"
          onClick={() => onAction('reset')}
        >
          <UxGlyph name="restart" size={16} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={value.state === 'running' ? 'Pause' : 'Resume'}
          title="Pause or resume · Space"
          onClick={() => onAction(value.state === 'running' ? 'pause' : 'resume')}
        >
          <UxGlyph name={value.state === 'running' ? 'pause' : 'play'} size={16} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close teleprompter"
          title="Close teleprompter · Esc"
          onClick={() => onAction('stop')}
        >
          <UxGlyph name="close" size={16} />
        </Button>
      </header>
      <div className="prompter-viewport">
        <div className="prompter-script" style={{ fontSize: `${value.fontSize || 24}px` }}>
          <span className="prompter-read">{script.slice(0, read)}</span>
          {script.slice(read)}
        </div>
      </div>
    </main>
  );
}

// Word start offsets arrive delta-encoded alongside the script.
const decodeStarts = (deltas) => {
  let position = 0;
  return Array.isArray(deltas) ? deltas.map((delta) => (position += Number(delta) || 0)) : [];
};

/**
 * Measure the rendered script: the line top of every word (as
 * `[firstWordIndex, top]` runs), the text height and the scroll range, in CSS
 * pixels relative to the script's top. The shell scrolls and follows the
 * voice from this instead of estimating the layout.
 */
export function measureTeleprompterLayout(host, starts) {
  const viewport = host.querySelector('.prompter-viewport');
  const script = host.querySelector('.prompter-script');
  if (!viewport || !script) return null;
  const nodes = [];
  const walker = document.createTreeWalker(script, NodeFilter.SHOW_TEXT);
  for (let base = 0, node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push([node, base]);
    base += node.length;
  }
  const origin = script.getBoundingClientRect();
  const range = document.createRange();
  const lines = [];
  let previous = null;
  let current = 0;
  for (let index = 0; index < starts.length; index += 1) {
    const offset = starts[index];
    while (current + 1 < nodes.length && nodes[current + 1][1] <= offset) current += 1;
    const [node, base] = nodes[current] || [];
    const local = node ? offset - base : -1;
    if (!node || local < 0 || local >= node.length) continue;
    const code = node.data.charCodeAt(local);
    const end = Math.min(node.length, local + (code >= 0xd800 && code <= 0xdbff ? 2 : 1));
    range.setStart(node, local);
    range.setEnd(node, end);
    const rects = range.getClientRects();
    const rect = rects[rects.length - 1] || range.getBoundingClientRect();
    const top = Math.max(0, Math.round((rect.top - origin.top) * 2) / 2);
    if (previous === null || Math.abs(top - previous) >= 1) {
      lines.push([lines.length ? index : 0, top]);
      previous = top;
    }
  }
  const trailing = parseFloat(getComputedStyle(script).paddingBottom) || 0;
  return {
    textHeight: Math.max(0, origin.height - trailing),
    viewport: Math.max(1, viewport.clientHeight),
    maximum: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
    lines,
  };
}

export function mountTeleprompterOverlay(host, onAction, onLayout) {
  const root = createRoot(host);
  let previousScript = null;
  let previousRead = -1;
  let previousState = '';
  let previousFont = 0;
  let previousInset = -1;
  let previousPace = 0;
  let previousMode = '';
  let previousError = '';
  let starts = [];
  let layoutId = null;
  let measuredFor = null;
  let pending = 0;
  const measure = () => {
    pending = 0;
    if (typeof onLayout !== 'function' || layoutId === null) return;
    const layout = measureTeleprompterLayout(host, starts);
    if (!layout) return;
    measuredFor = layoutId;
    onLayout({ layoutId, ...layout });
  };
  const schedule = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      if (document.fonts?.status === 'loading') document.fonts.ready.then(measure, measure);
      else measure();
    });
  };
  // The window is resized natively (and again after a measurement changes
  // its height); re-measure whenever the viewport changes size.
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  let observed = null;
  return {
    update(value) {
      if (value.words !== undefined && value.script !== previousScript) starts = decodeStarts(value.words);
      if (
        value.script !== previousScript ||
        value.read !== previousRead ||
        value.state !== previousState ||
        value.fontSize !== previousFont ||
        value.inset !== previousInset ||
        value.pace !== previousPace ||
        value.mode !== previousMode ||
        value.error !== previousError
      ) {
        flushSync(() => root.render(<TeleprompterOverlay value={value} onAction={onAction} />));
        previousScript = value.script;
        previousRead = value.read;
        previousState = value.state;
        previousFont = value.fontSize;
        previousInset = value.inset;
        previousPace = value.pace;
        previousMode = value.mode;
        previousError = value.error;
      }
      const viewport = host.querySelector('.prompter-viewport');
      if (viewport && resize && observed !== viewport) {
        if (observed) resize.unobserve(observed);
        observed = viewport;
        resize.observe(viewport);
      }
      if (Number.isSafeInteger(value.layoutId) && value.layoutId !== layoutId) layoutId = value.layoutId;
      if (layoutId !== null && measuredFor !== layoutId) schedule();
      if (viewport)
        viewport.scrollTop = Math.max(
          0,
          (viewport.scrollHeight - viewport.clientHeight) * (value.progress || 0),
        );
    },
    unmount: () => {
      resize?.disconnect();
      if (pending) cancelAnimationFrame(pending);
      root.unmount();
    },
  };
}
