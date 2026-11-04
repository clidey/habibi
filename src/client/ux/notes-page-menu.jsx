import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@clidey/ux';
import { UxGlyph } from './glyph.jsx';

/** Secondary page actions stay available without surrounding the document. */
export function mountNotesPageMenu(host, actions) {
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="notes-icon-button habibi-control"
            aria-label="Note actions"
          >
            <UxGlyph name="more" size={16} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (document.activeElement?.closest('.tiptap, [role="dialog"]')) event.preventDefault();
          }}
        >
          {actions.map(({ label, action, disabled, danger }) => (
            <DropdownMenuItem
              key={label}
              disabled={disabled}
              className={danger ? 'notes-menu-danger' : ''}
              onSelect={action}
            >
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>,
    ),
  );
  return { unmount: () => root.unmount() };
}
