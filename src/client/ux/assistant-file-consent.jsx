import React, { useState } from 'react';
import {
  Button,
  Checkbox,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Spinner,
  TextArea,
} from '@clidey/ux';
import { fileTaskLabels } from './assistant-file-values.js';
export function AssistantFileConsent({ model, onAction }) {
  const [task, setTask] = useState(model.task || 'organize');
  const [instructions, setInstructions] = useState(model.request);
  const [contents, setContents] = useState(false);
  const [cleanup, setCleanup] = useState(false);
  return (
    <>
      <label className="assistant-field">
        Task
        <Select value={task} onValueChange={setTask}>
          <SelectTrigger aria-label="File task">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(fileTaskLabels).map(([id, label]) => (
              <SelectItem key={id} value={id}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="assistant-field assistant-instructions">
        Instructions
        <TextArea
          aria-label="File instructions"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          maxLength={4000}
          rows={3}
        />
      </label>
      <p className="assistant-share-note">
        Preparing with AI shares relative filenames, sizes, and dates with your configured provider.
        The selected folder limits access. This only prepares a plan. Compression, PDF processing,
        output previews, and file changes each require your explicit confirmation.
      </p>
      <label className="assistant-check">
        <Checkbox
          checked={contents}
          onCheckedChange={(value) => setContents(value === true)}
          aria-label="Include readable file contents"
        />
        <span>
          Include readable contents for better names and extraction
          <small>
            Up to 3,000 characters per file, 48,000 total. PDF text and image text are extracted
            locally.
          </small>
        </span>
      </label>
      <label className="assistant-check">
        <Checkbox
          checked={cleanup}
          onCheckedChange={(value) => setCleanup(value === true)}
          aria-label="Allow cleanup"
        />
        <span>
          Allow cleanup
          <small>
            Permits proposing moves to Trash. Every removal still needs your review. No permanent
            deletion.
          </small>
        </span>
      </label>
      <div className="assistant-card-actions">
        {['storage', 'duplicates'].includes(task) && (
          <Button
            variant="outline"
            disabled={model.busy}
            onClick={() =>
              onAction('prepare', {
                request: instructions,
                task,
                shareContents: false,
                allowCleanup: false,
                allowModel: false,
              })
            }
          >
            Scan locally
          </Button>
        )}
        <Button
          disabled={model.busy}
          onClick={() =>
            onAction('prepare', {
              request: instructions,
              task,
              shareContents: contents,
              allowCleanup: cleanup,
              allowModel: true,
            })
          }
        >
          {model.busy ? (
            <>
              <Spinner /> Preparing…
            </>
          ) : (
            'Prepare with AI'
          )}
        </Button>
      </div>
    </>
  );
}
