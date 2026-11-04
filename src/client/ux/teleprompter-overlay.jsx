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

export function mountTeleprompterOverlay(host, onAction) {
  const root = createRoot(host);
  let previousScript = null;
  let previousRead = -1;
  let previousState = '';
  let previousFont = 0;
  let previousInset = -1;
  let previousPace = 0;
  let previousMode = '';
  let previousError = '';
  return {
    update(value) {
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
      if (viewport)
        viewport.scrollTop = Math.max(
          0,
          (viewport.scrollHeight - viewport.clientHeight) * (value.progress || 0),
        );
    },
    unmount: () => root.unmount(),
  };
}
