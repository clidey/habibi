import React, { useState } from 'react';
import { Badge, Button, CatalogIcon, Input } from '@clidey/ux';
import './interactive.css';
export function DailyPlanDemo({ kind = 'timer' }) {
  const reminder = kind === 'reminder';
  const [title, setTitle] = useState(reminder ? 'Pack lunch' : 'Write proposal');
  const [state, setState] = useState('ready');
  const [minutes, setMinutes] = useState(17);
  return (
    <section
      className="habibi-demo not-prose"
      aria-label={reminder ? 'Interactive reminder review' : 'Interactive timer review'}
    >
      <header className="habibi-demo-heading">
        <div>
          <Badge variant="secondary">Interactive demo</Badge>
          <h3>{reminder ? 'Review a reminder' : 'A proposal is not a running timer'}</h3>
          <p>Local simulation. No notifications, running clock, or Apple Reminders access.</p>
        </div>
      </header>
      <div className="habibi-demo-body">
        <p className="habibi-demo-request">
          {reminder
            ? 'Remind me tomorrow at noon to pack lunch.'
            : 'Prepare a 17 minute focus timer called Write proposal.'}
        </p>
        <label className="habibi-demo-field">
          {reminder ? 'Reminder title' : 'Session name'}
          <Input
            aria-label={reminder ? 'Demo reminder title' : 'Demo session name'}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={state !== 'ready'}
          />
        </label>
        {!reminder && (
          <label className="habibi-demo-field">
            Minutes
            <Input
              aria-label="Demo timer minutes"
              type="number"
              min={1}
              max={240}
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
              disabled={state !== 'ready'}
            />
          </label>
        )}
        {reminder && (
          <p className="habibi-demo-caption">Due: tomorrow, 12:00 PM · List: Personal</p>
        )}
        <p className="habibi-demo-status" role="status">
          <CatalogIcon name="shield" size={18} />
          <span>
            {state === 'ready'
              ? 'Prepared only. Nothing has started or been saved.'
              : reminder
                ? `Demo reminder saved only after confirmation: ${title}.`
                : `Demo timer ${state}: ${title}, ${minutes} minutes. In Habibi, it keeps running when the launcher closes.`}
          </span>
        </p>
        <div className="habibi-demo-actions">
          {state === 'ready' ? (
            <Button
              disabled={
                !title.trim() ||
                (!reminder && (!Number.isInteger(minutes) || minutes < 1 || minutes > 240))
              }
              onClick={() => setState(reminder ? 'saved' : 'running')}
            >
              {reminder ? 'Confirm demo reminder' : 'Start demo session'}
            </Button>
          ) : (
            <>
              {!reminder && (
                <Button
                  variant="outline"
                  onClick={() => setState(state === 'running' ? 'paused' : 'running')}
                >
                  {state === 'running' ? 'Pause demo' : 'Resume demo'}
                </Button>
              )}
              <Button variant="outline" onClick={() => setState('ready')}>
                Reset demo
              </Button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
