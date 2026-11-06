import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  Button,
  CatalogIcon,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@clidey/ux';
import { fileTaskLabels as labels, fileBytes as bytes } from './assistant-file-values.js';
import { AssistantFileConsent } from './assistant-file-consent.jsx';
import { AssistantFileChanges } from './assistant-file-changes.jsx';
function FileCard({ model, onAction }) {
  const [selected, setSelected] = useState(null);
  const [confirm, setConfirm] = useState('');
  const plan = model.result?.plan;
  const chosen = selected || plan?.changes.map((_, index) => index) || [];
  const file = (id) => plan?.entries.find((entry) => entry.id === id);
  return (
    <section className="assistant-file-card" aria-label="File task">
      <header>
        <CatalogIcon name="folder" size={22} />
        <div>
          <h3>{plan ? labels[plan.task] : 'Work with selected files'}</h3>
          <p>{model.grants.map((grant) => grant.name).join(' · ')}</p>
        </div>
        <span className="assistant-local-label">
          {plan?.status === 'applied' ? 'APPLIED' : 'REVIEW FIRST'}
        </span>
      </header>
      {!plan && <AssistantFileConsent model={model} onAction={onAction} />}
      {plan && (
        <>
          <p className="assistant-plan-summary">{plan.summary}</p>
          {plan.warning && <p className="assistant-share-note">{plan.warning}</p>}
          {model.result.storage && (
            <div className="assistant-file-stats">
              <span>{model.result.storage.files} files</span>
              <span>{bytes(model.result.storage.totalBytes)} scanned</span>
              <span>
                {model.result.provider}
                {model.result.model ? ` · ${model.result.model}` : ''}
              </span>
            </div>
          )}
          {plan.changes.length > 0 && (
            <AssistantFileChanges
              plan={plan}
              chosen={chosen}
              busy={model.busy}
              previews={model.result.previews}
              onSelect={setSelected}
            />
          )}
          {model.result.duplicates?.groups?.length > 0 && (
            <details>
              <summary>{model.result.duplicates.groups.length} groups of identical files</summary>
              {model.result.duplicates.groups.map((group) => (
                <p key={group.hash}>
                  {group.ids.map((id) => file(id)?.relative).join(' = ')} · {bytes(group.bytes)}{' '}
                  redundant
                </p>
              ))}
            </details>
          )}
          {plan.findings?.map((item) => (
            <p key={item.fileId}>
              <b>{file(item.fileId)?.relative}</b> — {item.reason}
            </p>
          ))}
          {plan.task === 'storage' && (
            <details open>
              <summary>Largest files in this scan</summary>
              {model.result.storage.largest.slice(0, 10).map((item) => (
                <div className="assistant-storage-row" key={item.id}>
                  <span>{item.relative}</span>
                  <b>{bytes(item.size)}</b>
                </div>
              ))}
            </details>
          )}
          <div className="assistant-card-actions">
            {plan.status === 'preview' && (
              <>
                <Button variant="outline" disabled={model.busy} onClick={() => onAction('revise')}>
                  Revise request
                </Button>
                {chosen.some((index) =>
                  ['image', 'pdf', 'csv'].includes(plan.changes[index]?.kind),
                ) && (
                  <Button
                    variant="outline"
                    disabled={model.busy}
                    onClick={() => setConfirm('preview')}
                  >
                    Review output preview
                  </Button>
                )}
                <Button disabled={model.busy || !chosen.length} onClick={() => setConfirm('apply')}>
                  Review {chosen.length} change{chosen.length === 1 ? '' : 's'}
                </Button>
              </>
            )}
            {plan.status === 'applied' && (
              <Button variant="outline" disabled={model.busy} onClick={() => setConfirm('undo')}>
                Undo these changes
              </Button>
            )}
            {plan.status === 'undone' && (
              <p role="status">Changes undone. Generated copies were retained privately.</p>
            )}
          </div>
          {plan.outputs?.map((output) => (
            <div className="assistant-output" key={output}>
              <span>{output}</span>
              <Button size="sm" variant="ghost" onClick={() => onAction('open', { path: output })}>
                Open
              </Button>
            </div>
          ))}
        </>
      )}
      {model.error && (
        <p className="assistant-task-error" role="alert">
          {model.error}
        </p>
      )}
      <Dialog open={Boolean(confirm)} onOpenChange={(open) => !open && setConfirm('')}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === 'preview'
                ? 'Generate selected output previews?'
                : confirm === 'undo'
                  ? 'Undo these changes?'
                  : `Apply ${chosen.length} selected changes?`}
            </DialogTitle>
            <DialogDescription>
              {confirm === 'preview'
                ? 'Only the selected conversions will run, creating private preview copies. Original files stay unchanged. Saving the outputs requires a separate confirmation.'
                : confirm === 'undo'
                  ? 'Original names and locations will be restored if the files have not changed. Generated outputs are kept in private undo storage.'
                  : chosen.some((index) => plan?.changes[index]?.kind === 'trash')
                    ? 'Selected files will move to Trash. Nothing is permanently deleted. Existing destination files will never be overwritten.'
                    : 'Review the before and after names above. Existing files will never be overwritten. You can undo changes in this conversation.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm('')}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const action = confirm;
                setConfirm('');
                onAction(action, {
                  selected: chosen,
                  cleanupAcknowledged: chosen.some(
                    (index) => plan?.changes[index]?.kind === 'trash',
                  ),
                });
              }}
            >
              {confirm === 'preview'
                ? 'Generate previews'
                : confirm === 'undo'
                  ? 'Undo changes'
                  : 'Apply selected changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
export function mountAssistantFileCard(host, model, onAction) {
  const root = createRoot(host);
  const update = (value) =>
    flushSync(() =>
      root.render(
        <FileCard key={value.result?.plan.id || 'draft'} model={value} onAction={onAction} />,
      ),
    );
  update(model);
  return { update, unmount: () => root.unmount() };
}
