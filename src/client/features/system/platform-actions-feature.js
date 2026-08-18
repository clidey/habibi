import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons, safeImageSrc } from '../../core/view-helpers.js';
import { createOpeningActions } from './opening-actions.js';

/** Owns reversible launch actions and approval-gated macOS process/system actions. */
export function createPlatformActionsFeature({
  input,
  defaultView,
  resultsView,
  count,
  notify,
  requestApproval,
  requestNativeLockScreen,
  onBack,
  onOpen,
}) {
  let runningApps = null;
  const find = (selector) => resultsView.querySelector(selector);
  const usage = (app) =>
    `${app.cpu.toFixed(1)}% CPU · ${app.memoryMb >= 1024 ? `${(app.memoryMb / 1024).toFixed(1)} GB` : `${app.memoryMb} MB`} RAM`;
  const appIcon = (app) =>
    app.path
      ? `<img src="${safeImageSrc(`/api/app-icon?path=${encodeURIComponent(app.path)}`)}" alt="" onerror="this.remove()" />`
      : icon('monitor');
  const opening = createOpeningActions({ notify });

  function showRunning(mode) {
    onOpen('running-apps');
    input.value = '';
    input.placeholder = 'Filter open applications…';
    const force = mode === 'force';
    count.textContent = force ? 'Force Quit · open apps' : 'Quit · open apps';
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-running-apps">${icon('arrow-left')} Habibi</button><span class="verified">● local process usage</span></div><section class="running-apps"><div class="running-apps-title"><span class="icon agents">${icon(force ? 'octagon-x' : 'circle-stop')}</span><span><b>${force ? 'Force Quit applications' : 'Quit applications'}</b><small>${force ? 'Use only when an app is unresponsive. It may lose unsaved work.' : 'Choose an open app to quit normally.'}</small></span><button type="button" class="history-button" id="refresh-running-apps">${icon('refresh-cw')} Refresh</button></div><div id="running-app-list" class="running-app-list"><div class="loading-state"><span class="spinner"></span> Reading open applications…</div></div></section>`,
    );
    find('#back-running-apps').onclick = onBack;
    runningApps = { mode, apps: [] };
    const load = () =>
      fetch('/api/running-apps')
        .then((response) => response.json())
        .then((data) => {
          if (runningApps?.mode !== mode) return;
          runningApps.apps = data.apps || [];
          filterRunning(input.value);
        })
        .catch(() => {
          const list = find('#running-app-list');
          if (list)
            setHtml(list, '<div class="local-files-empty">Could not read open applications.</div>');
        });
    find('#refresh-running-apps').onclick = load;
    load();
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  function filterRunning(query = '') {
    if (!runningApps) return;
    const list = find('#running-app-list');
    if (!list) return;
    const force = runningApps.mode === 'force';
    const needle = query.trim().toLowerCase();
    const apps = runningApps.apps.filter(
      (app) => !needle || `${app.name} ${app.path}`.toLowerCase().includes(needle),
    );
    count.textContent = `${apps.length} open app${apps.length === 1 ? '' : 's'}`;
    setHtml(
      list,
      apps.length
        ? apps
            .map(
              (app, index) =>
                `<button type="button" class="result running-app ${index === 0 ? 'selected' : ''}" data-running-app="${encodeURIComponent(JSON.stringify(app))}"><span class="icon app-icon">${appIcon(app)}</span><span><b>${escapeHtml(app.name)}</b><small>${escapeHtml(usage(app))} · ${app.pids.length} process${app.pids.length === 1 ? '' : 'es'}</small></span><em>${force ? 'FORCE QUIT' : 'QUIT'}</em><i>${icon('chevron-right')}</i></button>`,
            )
            .join('')
        : `<div class="local-files-empty">No open application matches “${escapeHtml(query)}”.</div>`,
    );
    list
      .querySelectorAll('[data-running-app]')
      .forEach(
        (button) =>
          (button.onclick = () =>
            confirmRunning(
              JSON.parse(decodeURIComponent(button.dataset.runningApp)),
              runningApps.mode,
            )),
      );
    refreshIcons();
  }

  function confirmRunning(app, mode) {
    const force = mode === 'force';
    const actionLabel = force ? 'Force Quit' : 'Quit';
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-running-apps">${icon('arrow-left')} ${force ? 'Force Quit applications' : 'Quit applications'}</button><span class="verified">● review before action</span></div><section class="system-action-confirm ${force ? 'is-dangerous' : ''}" data-confirm-choice="confirm"><div class="system-action-hero"><span class="system-action-icon">${icon(force ? 'octagon-x' : 'circle-stop')}</span><span><span class="compose-label">OPEN APPLICATION</span><h2>${escapeHtml(actionLabel)} ${escapeHtml(app.name)}?</h2><p>${force ? 'This immediately stops the app and may lose unsaved work.' : 'Habibi will ask this app to terminate normally.'}</p></span></div><div class="system-action-note">${icon('activity')}<span>${escapeHtml(usage(app))} across ${app.pids.length} process${app.pids.length === 1 ? '' : 'es'}.</span></div><div class="confirmation-options"><button type="button" class="confirmation-choice confirm-option selected" id="confirm-running-app" data-choice="confirm"><span><b>${escapeHtml(actionLabel)} ${escapeHtml(app.name)}</b><small>Requires your confirmation</small></span><kbd>↵</kbd></button><button type="button" class="confirmation-choice confirm-option" id="cancel-running-app" data-choice="cancel"><span><b>Cancel</b><small>Keep ${escapeHtml(app.name)} running</small></span><kbd>esc</kbd></button></div></section>`,
    );
    const back = () => showRunning(mode);
    find('#back-running-apps').onclick = back;
    find('#cancel-running-app').onclick = back;
    find('#confirm-running-app').onclick = async () => {
      const button = find('#confirm-running-app');
      button.disabled = true;
      setHtml(
        button,
        `<span><span class="mini-spinner"></span> ${escapeHtml(actionLabel)}ing…</span>`,
      );
      try {
        const payload = { app: app.name, mode, pids: app.pids };
        const approvalToken = await requestApproval(`running-app.${mode}`, payload);
        const result = await fetch('/api/running-apps/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, approvalToken }),
        }).then((response) => response.json());
        if (!result.ok) throw new Error(result.error);
        notify(`${app.name} is ${force ? 'being force quit' : 'quitting'}…`);
        showRunning(mode);
      } catch (error) {
        notify(error.message || `Could not ${actionLabel.toLowerCase()} ${app.name}`);
        button.disabled = false;
        setHtml(
          button,
          `<span><b>${escapeHtml(actionLabel)} ${escapeHtml(app.name)}</b><small>Requires your confirmation</small></span><kbd>↵</kbd>`,
        );
      }
    };
    requestAnimationFrame(() => find('#confirm-running-app')?.focus({ preventScroll: true }));
    refreshIcons();
  }

  function showSystem(action, title) {
    const copy = {
      sleep: 'Put this Mac to sleep.',
      restart: 'Restart this Mac and close open apps.',
      shutdown: 'Shut down this Mac and close open apps.',
      lock: 'Lock this Mac immediately.',
      darkMode: 'Change the macOS appearance.',
      emptyTrash: 'Permanently remove all Trash items.',
    }[action];
    if (!copy)
      return fetch('/api/system/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
        .then((response) => response.json())
        .then((result) =>
          notify(result.ok ? `Opened ${title}` : result.error || `Could not open ${title}`),
        );
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = 'System action';
    const meta = {
      sleep: {
        icon: 'moon',
        verb: 'Sleep now',
        detail: 'Your Mac can be woken with the keyboard, trackpad, or power button.',
      },
      restart: {
        icon: 'rotate-cw',
        verb: 'Restart now',
        detail: 'Any unsaved work in other apps may be lost.',
      },
      shutdown: {
        icon: 'power',
        verb: 'Shut down now',
        detail: 'Any unsaved work in other apps may be lost.',
      },
      lock: {
        icon: 'lock-keyhole',
        verb: 'Lock screen',
        detail: 'You’ll need your normal macOS sign-in to return.',
      },
      darkMode: {
        icon: 'sun-moon',
        verb: 'Change appearance',
        detail: 'This changes macOS appearance, not just Habibi.',
      },
      emptyTrash: {
        icon: 'trash-2',
        verb: 'Empty Trash',
        detail: 'Files in Trash cannot be restored after this action.',
      },
    }[action];
    const dangerous = ['restart', 'shutdown', 'emptyTrash'].includes(action);
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-system-action">${icon('arrow-left')} Habibi</button><span class="verified">● review before action</span></div><section class="system-action-confirm ${dangerous ? 'is-dangerous' : ''}" data-confirm-choice="confirm"><div class="system-action-hero"><span class="system-action-icon">${icon(meta.icon)}</span><span><span class="compose-label">SYSTEM ACTION</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p></span></div><div class="system-action-note">${icon('shield-check')}<span>${escapeHtml(meta.detail)}</span></div><div class="confirmation-options"><button type="button" class="confirmation-choice confirm-option selected" id="confirm-system-action" data-choice="confirm"><span><b>${escapeHtml(meta.verb)}</b><small>Requires your confirmation</small></span><kbd>↵</kbd></button><button type="button" class="confirmation-choice confirm-option" id="cancel-system-action" data-choice="cancel"><span><b>Keep things as they are</b><small>Return to Habibi</small></span><kbd>esc</kbd></button></div></section>`,
    );
    find('#back-system-action').onclick = onBack;
    find('#cancel-system-action').onclick = onBack;
    find('#confirm-system-action').onclick = async () => {
      try {
        if (action === 'lock') return await requestNativeLockScreen();
        const approvalToken = await requestApproval(`system.${action}`, { action });
        const result = await fetch('/api/system/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, approvalToken }),
        }).then((response) => response.json());
        if (!result.ok) throw new Error(result.error);
        notify(`${title} confirmed`);
        if (!['restart', 'shutdown'].includes(action)) onBack();
      } catch (error) {
        notify(error.message || 'Could not confirm this action');
      }
    };
    refreshIcons();
  }

  return {
    filterRunning,
    openApp: opening.openApp,
    openFolder: opening.openFolder,
    showRunning,
    showSystem,
  };
}
