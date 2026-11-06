import React from 'react';
import { Checkbox } from '@clidey/ux';
import { fileBytes as bytes } from './assistant-file-values.js';
export function AssistantFileChanges({ plan, chosen, busy, previews, onSelect }) {
  const file = (id) => plan.entries.find((entry) => entry.id === id);
  return (
    <div className="assistant-change-list">
      {plan.changes.map((change, index) => {
        const preview = previews?.find((item) => item.index === index);
        return (
          <label className="assistant-change" key={index}>
            <Checkbox
              aria-label={`Select change ${index + 1}`}
              disabled={busy || plan.status !== 'preview'}
              checked={chosen.includes(index)}
              onCheckedChange={(checked) =>
                onSelect(checked ? [...chosen, index] : chosen.filter((item) => item !== index))
              }
            />
            <div>
              <b>{change.sources.map((id) => file(id)?.relative).join(' + ')}</b>
              <span className={change.kind === 'trash' ? 'assistant-trash-label' : ''}>
                {change.kind === 'trash' ? '→ Move to Trash' : `→ ${change.destination}`}
              </span>
              <small>{change.reason}</small>
              {change.kind === 'pdf' && change.quality && (
                <small>
                  Compressed copy uses page images; selectable text and vectors become rasterized.
                </small>
              )}
              {change.width && <small>Width: {change.width} pixels</small>}
              {change.quality && <small>Quality: {change.quality}%</small>}
              {change.targetBytes && <small>Requested size: {bytes(change.targetBytes)}</small>}
              {change.pages && (
                <small>
                  Page order:{' '}
                  {change.pages
                    .map((page) => `${page.page}${page.rotate ? ` (${page.rotate}°)` : ''}`)
                    .join(', ')}
                </small>
              )}
              {['image', 'pdf', 'csv'].includes(change.kind) && !preview && (
                <small>Not processed. Conversion requires your confirmation.</small>
              )}
              {preview && (
                <small>
                  {bytes(preview.beforeBytes)} → {bytes(preview.afterBytes)}
                  {!preview.targetMet && ' · Requested size not reached'} ·{' '}
                  <a
                    href={`/api/file-tools/preview?plan=${encodeURIComponent(plan.id)}&index=${index}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Preview output
                  </a>
                </small>
              )}
            </div>
          </label>
        );
      })}
    </div>
  );
}
