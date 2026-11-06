import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Button, CatalogIcon, Spinner } from '@clidey/ux';
function ActionReview({ model, onAction }) {
  return (
    <section className="assistant-action-review" aria-label="Action confirmation">
      <header>
        <CatalogIcon name="shield" size={20} />
        <b>{model.title}</b>
      </header>
      <p>{model.detail}</p>
      {model.status === 'awaiting' && (
        <>
          <small>Nothing has run. Confirm this specific action to continue.</small>
          <div className="assistant-card-actions">
            <Button variant="outline" onClick={() => onAction('cancel')}>
              Cancel
            </Button>
            <Button data-confirm-assistant-action onClick={() => onAction('confirm')}>
              Confirm action
            </Button>
          </div>
        </>
      )}
      {model.status === 'running' && (
        <p role="status">
          <Spinner /> Running your confirmed action…
        </p>
      )}
      {model.status === 'cancelled' && <p role="status">Cancelled. Nothing ran.</p>}
      {model.status === 'done' && <p role="status">Confirmed action completed.</p>}
      {model.status === 'failed' && (
        <p role="alert">
          {model.error ||
            'The confirmed action could not complete. Ask again to prepare a fresh action.'}
        </p>
      )}
    </section>
  );
}
export function mountAssistantActionReview(host, model, onAction) {
  const root = createRoot(host);
  const update = (value) =>
    flushSync(() => root.render(<ActionReview model={value} onAction={onAction} />));
  update(model);
  return { update, unmount: () => root.unmount() };
}
