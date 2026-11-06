import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync, createPortal } from 'react-dom';
import { Badge, Button, CatalogIcon, Tooltip, TooltipTrigger, TooltipContent } from '@clidey/ux';
function Mentions({ model, onAction, tagHost }) {
  const tags = (
    <div className="assistant-path-chips" aria-label="Selected paths">
      {model.grants.map((grant) => (
        <Tooltip key={grant.id}>
          <TooltipTrigger asChild>
            <Badge variant="secondary" asChild>
              <Button
                className="assistant-path-tag"
                size="sm"
                variant="outline"
                aria-label={`Remove path ${grant.name}`}
                onClick={() => onAction('remove', grant)}
              >
                <CatalogIcon name={grant.directory ? 'folder' : 'file-text'} size={14} />
                <span className="assistant-path-tag-name">@{grant.name}</span>
                <CatalogIcon name="close" size={12} />
              </Button>
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{grant.path}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
  return (
    <>
      {tagHost ? createPortal(tags, tagHost) : tags}
      {model.open && (
        <section className="assistant-path-menu" aria-label="Mention a path">
          <p>Choose a file or folder · type an absolute path for other locations</p>
          <div role="listbox" aria-label="File and folder mentions">
            {model.items.map((item, index) => (
              <Button
                key={item.path}
                role="option"
                aria-selected={index === model.active}
                variant="ghost"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onAction('select', item)}
              >
                <CatalogIcon name={item.directory ? 'folder' : 'file-text'} size={16} />
                <span>
                  <b>{item.name}</b>
                  <small>{item.path}</small>
                </span>
              </Button>
            ))}
          </div>
          {!model.items.length && <p>No matching paths. Use @"/full/path with spaces".</p>}
        </section>
      )}
    </>
  );
}
export function mountPathMentions(host, model, onAction, tagHost) {
  const root = createRoot(host);
  return {
    update(value) {
      flushSync(() =>
        root.render(<Mentions model={value} onAction={onAction} tagHost={tagHost} />),
      );
    },
    unmount: () => root.unmount(),
  };
}
