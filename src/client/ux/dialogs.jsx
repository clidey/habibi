import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Spinner,
} from '@clidey/ux';
import { UxGlyph } from './glyph.jsx';

export function mountNotesDialog(host, title, content, onClose) {
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          className="notes-dialog"
          showCloseButton={false}
          aria-describedby={undefined}
        >
          <DialogHeader className="notes-dialog-header">
            <DialogTitle id="notes-dialog-title">{title}</DialogTitle>
            <Button
              type="button"
              className="notes-icon-button"
              id="notes-dialog-close"
              aria-label="Close dialog"
              onClick={onClose}
            >
              <UxGlyph name="close" />
            </Button>
          </DialogHeader>
          <div className="notes-dialog-body" dangerouslySetInnerHTML={{ __html: content }} />
        </DialogContent>
      </Dialog>,
    ),
  );
  return {
    root: document.querySelector('.notes-dialog[data-slot="dialog-content"]'),
    unmount: () => root.unmount(),
  };
}

export function mountUpdateDialog(host, state, onLater, onInstall) {
  const root = createRoot(host);
  const render = (next) => {
    const installing = ['downloading', 'installing'].includes(next?.state);
    const title = installing
      ? next.state === 'downloading'
        ? 'Downloading update…'
        : 'Installing and restarting…'
      : `Habibi ${next?.version || ''} is ready`;
    const copy = installing
      ? 'Keep this window open. Habibi will close and reopen automatically.'
      : 'The signed update will replace this copy of Habibi, then reopen automatically.';
    flushSync(() =>
      root.render(
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) onLater();
          }}
        >
          <DialogContent className="update-dialog-card" showCloseButton={false}>
            <UxGlyph name="download" size={24} />
            <div>
              <span className="briefing-heading">HABIBI UPDATE</span>
              <DialogHeader>
                <DialogTitle id="update-dialog-title">{title}</DialogTitle>
                <DialogDescription>{copy}</DialogDescription>
              </DialogHeader>
            </div>
            <div className="update-dialog-actions">
              {installing ? (
                <Spinner />
              ) : (
                <>
                  <Button className="secondary" data-update-later onClick={onLater}>
                    Later
                  </Button>
                  <Button className="primary" data-install-update onClick={onInstall}>
                    Install update
                  </Button>
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>,
      ),
    );
  };
  render(state);
  return { update: render, unmount: () => root.unmount() };
}
