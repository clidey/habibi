import React, { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  Button,
  CatalogIcon,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Spinner,
} from '@clidey/ux';
import { DailyClipboard } from './daily-clipboard.jsx';
import { DailyReminders } from './daily-reminders.jsx';
import { DailyFocus } from './daily-focus.jsx';
import { RecentFiles } from './recent-files.jsx';
const titles = {
  clipboard: 'Clipboard',
  reminders: 'Reminders',
  focus: 'Focus timer',
  recents: 'Recent files',
};
function DailyWorkspace({ model, onAction }) {
  const [confirm, setConfirm] = useState(null);
  const ask = (title, description, label, action, value) =>
    setConfirm({ title, description, label, action, value });
  return (
    <section
      className="daily-workspace"
      data-daily-workspace={model.name}
      aria-label={titles[model.name]}
    >
      <header className="daily-heading">
        <div>
          <p className="eyebrow">ON THIS MAC</p>
          <h2>{titles[model.name]}</h2>
        </div>
      </header>
      {model.error && (
        <p className="daily-error" role="alert">
          {model.error}
        </p>
      )}
      {model.loading ? (
        <div className="daily-empty">
          <Spinner />
          <p>Opening {titles[model.name].toLowerCase()}…</p>
        </div>
      ) : (
        <div className="daily-body">
          {model.name === 'clipboard' && (
            <DailyClipboard
              value={model.value}
              query={model.query}
              onAction={onAction}
              onConfirm={ask}
            />
          )}
          {model.name === 'reminders' && (
            <DailyReminders
              value={{
                ...model.value,
                items: (model.value.items || []).filter((item) =>
                  `${item.title} ${item.list}`.toLowerCase().includes(model.query.toLowerCase()),
                ),
              }}
              draft={model.draft}
              onAction={onAction}
              onConfirm={ask}
            />
          )}
          {model.name === 'focus' && (
            <DailyFocus value={model.value} initialMinutes={model.minutes} onAction={onAction} />
          )}
          {model.name === 'recents' && (
            <>
              <div className="daily-section-heading">
                <span>Opened and previewed in Habibi · drag files into attachments</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!model.value.items?.length}
                  onClick={() =>
                    ask(
                      'Forget recent files?',
                      'This clears the history. Your files stay in their original locations.',
                      'Clear history',
                      'recent.clear',
                      {},
                    )
                  }
                >
                  Clear history
                </Button>
              </div>
              <RecentFiles
                items={(model.value.items || []).filter((item) =>
                  `${item.name} ${item.path}`.toLowerCase().includes(model.query.toLowerCase()),
                )}
                onAction={(action, item) => onAction(`recent.${action}`, item)}
              />
            </>
          )}
        </div>
      )}
      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.title}</DialogTitle>
            <DialogDescription>{confirm?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const next = confirm;
                setConfirm(null);
                onAction(next.action, next.value);
              }}
            >
              {confirm?.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
export function mountDailyWorkspace(host, model, onAction) {
  const root = createRoot(host);
  const render = (value) =>
    flushSync(() => root.render(<DailyWorkspace model={value} onAction={onAction} />));
  render(model);
  return { update: render, unmount: () => root.unmount() };
}
