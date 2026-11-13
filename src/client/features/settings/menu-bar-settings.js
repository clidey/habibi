import { onMac } from '../../core/platform-copy.js';
import { setHtml } from '../../core/safe-dom.js';
import { icon } from '../../core/view-helpers.js';
import { refreshUxSwitch } from '../../ux/switch-control.js';

/** AppKit owns the saved preference; Settings reflects the native state. */
export function installMenuBarSettings(settings) {
  const bridge = window.webkit?.messageHandlers?.habibiNative;
  if (!bridge) return;
  const section = document.createElement('section');
  section.className = 'settings-section home-layout-settings';
  setHtml(
    section,
    `<div class="appearance-heading"><span class="briefing-heading">MENU BAR</span></div><label class="home-layout-control"><span class="home-layout-icon">${icon('panel-top')}</span><span><b>Show menu bar icon</b><small id="menu-bar-icon-note">Checking preference…</small></span><input type="checkbox" id="menu-bar-icon-enabled" aria-label="Show menu bar icon" disabled /></label>`,
  );
  settings.querySelector('.settings-section')?.after(section);
  const toggle = section.querySelector('#menu-bar-icon-enabled');
  const note = section.querySelector('#menu-bar-icon-note');
  window.__habibiMenuBarIconState = (result) => {
    if (!toggle.isConnected || typeof result?.enabled !== 'boolean') return;
    toggle.checked = result.enabled;
    toggle.disabled = false;
    refreshUxSwitch(toggle);
    const shortcut = document.body.dataset.nativeShortcutLabel || (onMac() ? '⌥ Space' : 'Alt+Space');
    note.textContent = result.enabled
      ? (onMac() ? 'Keep Habibi in the macOS menu bar.' : 'Keep Habibi in the system tray.')
      : `Use ${shortcut} or open ${onMac() ? 'Habibi.app' : 'Habibi'} to bring it back.`;
  };
  toggle.addEventListener('change', () => {
    toggle.disabled = true;
    refreshUxSwitch(toggle);
    bridge.postMessage({ type: 'menuBarIcon', enabled: toggle.checked });
  });
  bridge.postMessage({ type: 'menuBarIconState' });
}

export function closeMenuBarSettings() {
  delete window.__habibiMenuBarIconState;
}
