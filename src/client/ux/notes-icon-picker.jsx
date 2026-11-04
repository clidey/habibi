import React, { useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Button, Input, Popover, PopoverTrigger, PopoverContent, CatalogIcon } from '@clidey/ux';
import { icons } from '@clidey/ux/icons';
import { UxGlyph } from './glyph.jsx';

const names = Object.keys(icons).sort();
const suggested = ['file-text', 'file', 'folder', 'book', 'bookmark', 'pin', 'star', 'heart', 'home', 'organization', 'calendar', 'check-circle', 'flag', 'promote', 'ai', 'chat', 'mail', 'code', 'terminal', 'chart', 'globe', 'settings', 'database', 'source', 'beaker', 'play', 'camera', 'users'].filter(name => Object.hasOwn(icons, name));
const keywords = { promote: 'rocket launch', ai: 'idea brain sparkle', beaker: 'lab science test', organization: 'work briefcase office', file: 'document page', 'file-text': 'document page note', source: 'database data', chart: 'graph analytics' };
const label = name => name.replaceAll('-', ' ');
const validIcon = name => Object.hasOwn(icons, name) ? name : 'file-text';

function NoteIconPicker({ selected, disabled, onSelect }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(validIcon(selected));
  const choose = name => { setActive(name); onSelect(name); setOpen(false); };
  const search = useRef(null);
  const [query, setQuery] = useState('');
  const choices = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? names.filter(name => words.every(word => `${label(name)} ${keywords[name] || ''}`.includes(word))).slice(0, 140) : suggested;
  }, [query]);
  return <Popover open={open} onOpenChange={value => { setOpen(value); if (value) setQuery(''); }}>
    <PopoverTrigger asChild><Button variant="ghost" className="notes-note-icon" id="note-icon" aria-label="Change page icon" disabled={disabled}><CatalogIcon name={active} size={22} /></Button></PopoverTrigger>
    <PopoverContent className="notes-icon-picker" side="bottom" align="start" sideOffset={8} collisionPadding={12} aria-label="Choose a page icon" onOpenAutoFocus={event => { event.preventDefault(); search.current?.focus(); }}>
      <div className="notes-icon-heading"><span>Page icon</span><Button variant="ghost" size="icon" aria-label="Close icon picker" onClick={() => setOpen(false)}><UxGlyph name="close" size={16} /></Button></div>
      <Input ref={search} aria-label="Search icons" placeholder="Search icons…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && choices[0]) { event.preventDefault(); choose(choices[0]); }
        if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); event.currentTarget.closest('[data-slot="popover-content"]').querySelector('[data-note-icon]')?.focus(); }
      }} />
      <div className="notes-icon-results" onKeyDown={event => {
        const buttons = [...event.currentTarget.querySelectorAll('button')];
        const index = buttons.indexOf(document.activeElement);
        const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 }[event.key];
        if (step && index >= 0) { event.preventDefault(); event.stopPropagation(); buttons[Math.max(0, Math.min(buttons.length - 1, index + step))]?.focus(); }
      }}>
        {choices.map(name => <Button key={name} variant="ghost" size="icon" className="notes-icon-option" data-note-icon={name} aria-label={label(name)} title={label(name)} aria-pressed={active === name} onClick={() => choose(name)}><CatalogIcon name={name} size={20} /></Button>)}
        {!choices.length && <p className="notes-icon-no-results">No icons found. Try another word.</p>}
      </div>
    </PopoverContent>
  </Popover>;
}

export function mountNoteIconPicker(host, selected, disabled, onSelect) {
  const root = createRoot(host);
  flushSync(() => root.render(<NoteIconPicker selected={selected} disabled={disabled} onSelect={onSelect} />));
  return { unmount: () => root.unmount() };
}
