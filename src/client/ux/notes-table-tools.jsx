import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@clidey/ux';
import { UxGlyph } from './glyph.jsx';

export function mountNoteTableTools(host, run) {
  const root = createRoot(host);
  flushSync(() => root.render(<div className="notes-table-actions" role="toolbar" aria-label="Table actions">
    <span>Table</span>
    <Button variant="ghost" size="sm" onClick={() => run('addRowAfter')}>+ Row</Button>
    <Button variant="ghost" size="sm" onClick={() => run('addColumnAfter')}>+ Column</Button>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="More table actions"><UxGlyph name="more" size={16} /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={event => event.preventDefault()}>
        {[
          ['addRowBefore', 'Insert row above'], ['addRowAfter', 'Insert row below'],
          ['addColumnBefore', 'Insert column left'], ['addColumnAfter', 'Insert column right'],
        ].map(([command, label]) => <DropdownMenuItem key={command} onSelect={() => run(command)}>{label}</DropdownMenuItem>)}
        <DropdownMenuSeparator />
        {[
          ['deleteRow', 'Delete row'], ['deleteColumn', 'Delete column'], ['deleteTable', 'Delete table'],
        ].map(([command, label]) => <DropdownMenuItem key={command} onSelect={() => run(command)}>{label}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>));
  return { unmount: () => root.unmount() };
}
