import React from 'react';
import { Button, CatalogIcon, Switch } from '@clidey/ux';
export function DailyClipboard({ value, query, onAction, onConfirm }) {
  const items = (value.items || []).filter((item) =>
    `${item.name} ${item.text} ${item.source}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="daily-status-card">
        <span>
          <b>{value.enabled ? 'Clipboard history is on' : 'Clipboard history is paused'}</b>
          <small>
            Text, images, and files stay on this Mac for 7 days. Pin up to 20 items to keep them.
          </small>
        </span>
        <Switch
          aria-label="Enable clipboard history"
          checked={Boolean(value.enabled)}
          onCheckedChange={(enabled) => onAction('clipboard.enable', { enabled })}
        />
      </div>
      <div className="daily-section-heading">
        <span>{items.length} items · sensitive clipboard types and password apps are excluded</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={!value.items?.length}
          onClick={() =>
            onConfirm(
              'Clear clipboard history?',
              'This removes Habibi’s saved copies. Your current system clipboard stays unchanged.',
              'Clear history',
              'clipboard.remove',
              {},
            )
          }
        >
          Clear history
        </Button>
      </div>
      <div className="daily-clipboard-list">
        {items.map((item) => (
          <div
            key={item.id}
            className={`daily-item${item.path ? ' recent-file' : ''}`}
            data-path={item.path ? encodeURIComponent(item.path) : undefined}
            data-title={item.name}
            draggable={Boolean(item.path)}
          >
            {item.kind === 'image' || item.previewPath ? (
              <img
                className="daily-clip-image"
                src={`/api/file?path=${encodeURIComponent(item.previewPath || item.path)}`}
                alt="Copied image"
                loading="lazy"
              />
            ) : (
              <CatalogIcon name={item.kind === 'file' ? 'file' : 'copy'} size={22} />
            )}
            <Button
              variant="ghost"
              className="daily-item-copy"
              onClick={() => onAction('clipboard.copy', { id: item.id })}
            >
              <b>{item.name}</b>
              <small>
                {item.source} ·{' '}
                {new Date(item.createdAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </small>
            </Button>
            <div className="daily-item-actions">
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${item.pinned ? 'Unpin' : 'Pin'} clipboard item`}
                aria-pressed={item.pinned}
                onClick={() => onAction('clipboard.pin', { id: item.id, pinned: !item.pinned })}
              >
                <CatalogIcon name="pin" size={16} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove clipboard item"
                onClick={() => onAction('clipboard.remove', { id: item.id })}
              >
                <CatalogIcon name="close" size={16} />
              </Button>
            </div>
          </div>
        ))}
      </div>
      {!items.length && (
        <div className="daily-empty">
          <CatalogIcon name="copy" size={32} />
          <b>
            {value.enabled
              ? 'Copy something to get started.'
              : 'Turn on history to see what you copy.'}
          </b>
          <p>Click an item to copy it again. You can pause collection at any time.</p>
        </div>
      )}
    </>
  );
}
