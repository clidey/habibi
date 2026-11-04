import React, { useState } from 'react';
import {
  Button,
  CatalogIcon,
  Input,
  TextArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@clidey/ux';
export function DailyReminders({ value, draft, onAction, onConfirm }) {
  const [title, setTitle] = useState(draft?.title || '');
  const [due, setDue] = useState(draft?.due || '');
  const [notes, setNotes] = useState('');
  const [list, setList] = useState('');
  const [saving, setSaving] = useState(false);
  if (!value.access)
    return (
      <div className="daily-empty">
        <CatalogIcon name="check-circle" size={36} />
        <b>Your tasks, in Apple Reminders.</b>
        <p>
          {value.reason === 'denied'
            ? 'Allow Habibi in System Settings → Privacy & Security → Reminders, then refresh.'
            : 'Connect Reminders to see your lists, add a task, and mark it complete.'}
        </p>
        {value.reason === 'denied' ? (
          <>
            <Button onClick={() => onAction('reminders.settings')}>Open Reminders settings</Button>
            <Button variant="ghost" onClick={() => onAction('reminders.state')}>
              Refresh access
            </Button>
          </>
        ) : (
          <Button onClick={() => onAction('reminders.access')}>Connect Apple Reminders</Button>
        )}
      </div>
    );
  return (
    <div className="daily-reminders-layout">
      <form
        className="daily-reminder-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          onAction('reminders.create', {
            title: title.trim(),
            due: due ? new Date(due).toISOString() : '',
            listId: list || value.defaultList,
            notes,
            approved: true,
          })
            .then((ok) => {
              if (ok) {
                setTitle('');
                setNotes('');
              }
            })
            .finally(() => setSaving(false));
        }}
      >
        <h3>New reminder</h3>
        <label>
          What needs doing?
          <Input
            aria-label="Reminder title"
            placeholder="Call the dentist"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={500}
            required
          />
        </label>
        <label>
          When
          <Input
            aria-label="Reminder due date"
            type="datetime-local"
            value={due}
            onChange={(event) => setDue(event.target.value)}
          />
        </label>
        <label>
          List
          <Select value={list || value.defaultList || value.lists?.[0]?.id} onValueChange={setList}>
            <SelectTrigger aria-label="Reminder list">
              <SelectValue placeholder="Choose a list" />
            </SelectTrigger>
            <SelectContent>
              {(value.lists || []).map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label>
          Notes
          <TextArea
            aria-label="Reminder notes"
            placeholder="Optional context or link"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={10000}
            rows={3}
          />
        </label>
        <small>Review the task and date. Creating saves it to Apple Reminders.</small>
        <Button type="submit" disabled={saving || !title.trim() || !value.lists?.length}>
          {saving ? 'Creating…' : 'Create reminder'}
        </Button>
      </form>
      <section className="daily-reminder-list" aria-label="Incomplete reminders">
        <div className="daily-section-heading">
          <h3>To do</h3>
          <Button variant="ghost" size="sm" onClick={() => onAction('reminders.state')}>
            Refresh
          </Button>
        </div>
        {(value.items || []).map((item) => (
          <div className="daily-item" key={item.id}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Complete ${item.title}`}
              onClick={() =>
                onConfirm(
                  `Complete “${item.title}”?`,
                  'This marks the task complete in Apple Reminders.',
                  'Mark complete',
                  'reminders.complete',
                  { id: item.id, approved: true },
                )
              }
            >
              <CatalogIcon name="check-circle" size={20} />
            </Button>
            <span className="daily-item-copy">
              <b>{item.title}</b>
              <small>
                {item.list}
                {item.due
                  ? ` · ${new Date(item.due).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                  : ''}
              </small>
            </span>
          </div>
        ))}
        {!value.items?.length && <p className="daily-subtle">You’re all caught up.</p>}
      </section>
    </div>
  );
}
