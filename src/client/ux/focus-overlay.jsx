import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Button, CatalogIcon } from '@clidey/ux';
import { focusTime } from './daily-focus.jsx';
export function mountFocusOverlay(host, onAction) {
  const root = createRoot(host);
  const render = (value) =>
    flushSync(() =>
      root.render(
        <main className="focus-notch" style={{ paddingTop: `${value.inset || 0}px` }}>
          <div className="focus-notch-row">
            <span className="focus-notch-label">
              {value.state === 'finished' ? 'Session complete' : value.label || 'Focus'}
            </span>
            <strong role="timer">{focusTime(value.remaining || 0)}</strong>
            {['running', 'paused'].includes(value.state) && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={value.state === 'running' ? 'Pause timer' : 'Resume timer'}
                onClick={() => onAction(value.state === 'running' ? 'pause' : 'resume')}
              >
                <CatalogIcon name={value.state === 'running' ? 'columns' : 'play'} size={16} />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Hide timer"
              onClick={() => onAction('hide')}
            >
              <CatalogIcon name="close" size={16} />
            </Button>
          </div>
        </main>,
      ),
    );
  render({ state: 'idle' });
  return { update: render, unmount: () => root.unmount() };
}
