import React, { useState } from 'react';
import { Button, Input, CatalogIcon } from '@clidey/ux';
export const focusTime = (seconds) =>
  `${String(Math.floor(Math.max(0, seconds) / 60)).padStart(2, '0')}:${String(Math.floor(Math.max(0, seconds)) % 60).padStart(2, '0')}`;
export function DailyFocus({ value, initialMinutes, onAction }) {
  const [minutes, setMinutes] = useState(initialMinutes || 25);
  const [label, setLabel] = useState('Focus');
  const busy = value.state === 'running' || value.state === 'paused';
  return (
    <section className="daily-focus">
      <span className="eyebrow">A LITTLE SPACE TO FOCUS</span>
      <h2>
        {value.state === 'finished'
          ? 'Session complete.'
          : busy
            ? value.label
            : 'One thing at a time.'}
      </h2>
      <div className="daily-focus-clock" role="timer" aria-label="Time remaining">
        {focusTime(value.state === 'idle' || !value.state ? minutes * 60 : value.remaining)}
      </div>
      {!busy && (
        <>
          <div className="daily-focus-presets">
            {[
              [25, '25 min focus'],
              [50, '50 min focus'],
              [5, '5 min break'],
            ].map(([duration, title]) => (
              <Button
                key={duration}
                variant={minutes === duration ? 'secondary' : 'ghost'}
                aria-pressed={minutes === duration}
                onClick={() => {
                  setMinutes(duration);
                  setLabel(duration === 5 ? 'Break' : 'Focus');
                }}
              >
                {title}
              </Button>
            ))}
          </div>
          <div className="daily-focus-fields">
            <label>
              Minutes
              <Input
                type="number"
                min={1}
                max={240}
                aria-label="Focus duration in minutes"
                value={minutes}
                onChange={(event) => setMinutes(Number(event.target.value))}
              />
            </label>
            <label>
              Session name
              <Input
                aria-label="Focus session name"
                maxLength={100}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
          </div>
        </>
      )}
      <div className="daily-focus-actions">
        {busy ? (
          <>
            <Button
              onClick={() =>
                onAction('focus', {
                  value: { action: value.state === 'running' ? 'pause' : 'resume' },
                })
              }
            >
              {value.state === 'running' ? 'Pause' : 'Resume'}
            </Button>
            <Button
              variant="outline"
              onClick={() => onAction('focus', { value: { action: 'reset' } })}
            >
              End session
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                onAction('focus', { value: { action: value.visible ? 'hide' : 'show' } })
              }
            >
              {value.visible ? 'Hide' : 'Show'} near the notch
            </Button>
          </>
        ) : (
          <Button
            disabled={!Number.isFinite(minutes) || minutes < 1 || minutes > 240}
            onClick={() =>
              onAction('focus', { value: { action: 'start', seconds: minutes * 60, label } })
            }
          >
            <CatalogIcon name="play" size={18} /> Start session
          </Button>
        )}
      </div>
      <p className="daily-subtle">
        The timer keeps running when you close Habibi’s window or hide the notch display.
      </p>
    </section>
  );
}
