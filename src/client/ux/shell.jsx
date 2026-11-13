import { thisDevice } from '../core/platform-copy.js';
import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  Button as UxButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Kbd,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@clidey/ux';
import { RecentFilesTray } from './recent-files.jsx';
import { UxGlyph } from './glyph.jsx';

function Button({ className = '', ...props }) {
  return <UxButton {...props} className={`${className} habibi-control`} />;
}

function SidebarTooltip({ label, children }) {
  return (
    <Tooltip delayDuration={300} disableHoverableContent>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

const workspaces = [
  ['home', 'Home', 'house'],
  ['ask', 'Ask Habibi', 'message-circle'],
  ['whatsapp', 'WhatsApp', 'whatsapp'],
  ['mail', 'Mail', 'mail'],
  ['calendar', 'Calendar', 'calendar-days'],
  ['notes', 'Notes', 'file-text'],
  ['whodb', 'WhoDB', 'database'],
];

function Shell() {
  return (
    <>
      <nav className="navigation-rail" aria-label="Workspaces">
        <SidebarTooltip label="Habibi preferences">
          <Button
            id="open-preferences"
            className="rail-brand"
            type="button"
            aria-label="Habibi preferences"
          >
            <img src="/assets/logo.png" alt="" />
          </Button>
        </SidebarTooltip>
        <div className="rail-destinations">
          {workspaces.map(([id, label, glyph]) => (
            <SidebarTooltip key={id} label={label}>
              <Button
                className={`rail-button${id === 'home' ? ' active' : ''}`}
                data-workspace-link={id}
                data-habibi-app={{ ask: 'assistant', mail: 'email', calendar: 'agenda' }[id] || id}
                aria-label={label}
                aria-current={id === 'home' ? 'page' : undefined}
              >
                <i data-ux-icon={glyph} />
              </Button>
            </SidebarTooltip>
          ))}
        </div>
        <SidebarTooltip label="Settings">
          <Button
            id="open-settings"
            className="rail-button rail-settings"
            data-workspace-link="settings"
            aria-label="Settings"
          >
            <i data-ux-icon="sliders-horizontal" />
          </Button>
        </SidebarTooltip>
      </nav>
      <header className="search-row">
        <span className="search-icon">
          <i data-ux-icon="search" />
        </span>
        <Input
          id="command-input"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search anything, or ask Habibi…"
          aria-label="Search or command"
        />
        <Button
          id="search-scope"
          className="scope-chip hidden"
          type="button"
          aria-label="Clear search scope"
        >
          <span />
          <i data-ux-icon="x" />
        </Button>
        <RecentFilesTray />
        <span className="local-status" title={`Habibi runs on ${thisDevice()}`}>
          <span className="live-dot" /> LOCAL
        </span>
      </header>
      <div id="routing-strip" className="routing-strip hidden" aria-live="polite" />
      <section id="default-view" className="content home-view">
        <div className="intro">
          <p className="eyebrow" id="home-date">
            YOUR DAY
          </p>
          <h1 id="home-title">Good to see you.</h1>
          <p id="home-subtitle">Your day, in one place. Type anything and Habibi routes it.</p>
        </div>
        <section id="proactive-briefing" className="proactive-briefing" aria-live="polite" />
        <section id="getting-started" className="getting-started hidden" aria-live="polite" />
        <div className="home-columns">
          <section className="home-calendar-panel">
            <div className="agenda-home-header">
              <span id="agenda-label">02 / UP NEXT</span>
              <Button id="open-agenda">
                View all <i data-ux-icon="arrow-right" />
              </Button>
            </div>
            <div id="agenda-glance" className="agenda-glance">
              <div className="searching-local">Loading your calendar…</div>
            </div>
          </section>
          <section id="proactive-mail" className="proactive-mail" aria-live="polite" />
        </div>
        <div id="quick-samples" className="quick-samples hidden">
          <span>04 / TRY ASKING</span>
          {['Summarize my unread mail', 'What does my week look like?', 'Find a local file'].map(
            (sample) => (
              <Button key={sample} data-sample={sample}>
                {sample} <i data-ux-icon="arrow-right" />
              </Button>
            ),
          )}
        </div>
      </section>
      <section id="results-view" className="content hidden" aria-live="polite" />
      <footer className="keyboard-footer">
        <span className="keyboard-hints">
          <span>
            <Kbd>↑↓</Kbd> navigate
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>esc</Kbd> <span id="escape-hint">close</span>
          </span>
        </span>
        <span className="footer-status">
          <Button id="update-available" className="update-available hidden" type="button" />
          <span id="result-count">6 skills available</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                id="app-menu-trigger"
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Habibi menu"
              >
                <UxGlyph name="more" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top">
              <DropdownMenuItem onSelect={() => document.querySelector('#open-settings')?.click()}>
                Preferences…
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  window.webkit?.messageHandlers?.habibiNative?.postMessage({ type: 'quitApp' })
                }
              >
                Quit Habibi
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </footer>
    </>
  );
}

export function mountShell(host, dropDock) {
  const shell = createRoot(host);
  flushSync(() => shell.render(<Shell />));
  if (dropDock) {
    const dock = createRoot(dropDock);
    flushSync(() =>
      dock.render(
        <>
          <span>Drop into</span>
          <Button data-drop-target="email">
            <span className="icon gmail">
              <i data-ux-icon="mail" />
            </span>{' '}
            Mail
          </Button>
        </>,
      ),
    );
  }
}
