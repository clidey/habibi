import React, { useState } from 'react';
import { Button, CatalogIcon, Input, Popover, PopoverContent, PopoverTrigger } from '@clidey/ux';
import { recentRequest, recentAction } from '../features/files/recent-files.js';

export function RecentFiles({ items = [], onAction, compact = false }) {
  return (
    <div className={`daily-recent-list${compact ? ' compact' : ''}`}>
      {items.map((item) => (
        <div
          key={item.id}
          className={`recent-file daily-item${item.available ? '' : ' unavailable'}`}
          data-path={encodeURIComponent(item.path)}
          data-title={item.name}
          draggable={item.available && item.kind === 'file'}
        >
          <CatalogIcon name={item.kind === 'folder' ? 'folder' : 'file-text'} size={22} />
          <Button
            variant="ghost"
            className="daily-item-copy"
            disabled={!item.available}
            onClick={() => onAction('open', item)}
          >
            <b>{item.name}</b>
            <small>
              {item.available ? item.path.replace(/^\/Users\/[^/]+/, '~') : 'Moved or unavailable'}
            </small>
          </Button>
          <div className="daily-item-actions">
            {item.kind === 'file' && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Attach ${item.name}`}
                title="Attach to the current draft"
                disabled={!item.available}
                onClick={() => onAction('attach', item)}
              >
                <CatalogIcon name="paperclip" size={16} />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${item.pinned ? 'Unpin' : 'Pin'} ${item.name}`}
              aria-pressed={item.pinned}
              onClick={() => onAction('pin', item)}
            >
              <CatalogIcon name="pin" size={16} />
            </Button>
            {!compact && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Forget ${item.name}`}
                onClick={() => onAction('remove', item)}
              >
                <CatalogIcon name="close" size={16} />
              </Button>
            )}
          </div>
        </div>
      ))}
      {!items.length && (
        <div className="daily-empty">
          <CatalogIcon name="folder" size={28} />
          <b>Keep your next attachment close.</b>
          <p>
            Files you open or preview in Habibi appear here. Drag one into a draft or another app.
          </p>
        </div>
      )}
    </div>
  );
}

export function RecentFilesTray() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  async function load() {
    try {
      setItems((await recentRequest()).items);
      setError('');
    } catch (failure) {
      setError(failure.message);
    }
  }
  async function act(action, item) {
    try {
      await recentAction(action, item);
      if (action === 'attach') setOpen(false);
      else await load();
    } catch (failure) {
      setError(failure.message);
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) {
          setQuery('');
          load();
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="recent-tray-trigger"
          aria-label="Recent file attachments"
          title="Recent files"
        >
          <CatalogIcon name="folder" size={20} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="recent-files-tray"
        align="end"
        sideOffset={12}
        aria-label="Recent files"
      >
        <div className="daily-section-heading">
          <span>
            <b>Recent files</b>
            <small>Drag into a draft or another app</small>
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close recent files"
            onClick={() => setOpen(false)}
          >
            <CatalogIcon name="close" size={16} />
          </Button>
        </div>
        <Input
          aria-label="Find a recent file"
          placeholder="Find a recent file…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {error && (
          <p role="alert" className="daily-error">
            {error}
          </p>
        )}
        <RecentFiles
          compact
          items={items
            .filter((item) =>
              `${item.name} ${item.path}`.toLowerCase().includes(query.toLowerCase()),
            )
            .slice(0, 30)}
          onAction={act}
        />
      </PopoverContent>
    </Popover>
  );
}
