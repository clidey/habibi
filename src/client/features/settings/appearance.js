import { themeCatalog } from './theme-catalog.js';

/** Appearance applies at startup without loading the Settings page. */
export function createAppearance() {
  function applyTheme(theme = localStorage.getItem('habibi.theme') || 'paper-ink') {
    const next = themeCatalog.some((item) => item.id === theme) ? theme : 'paper-ink';
    document.body.dataset.theme = next;
    localStorage.setItem('habibi.theme', next);
  }
  function applyColorMode(mode = localStorage.getItem('habibi.color-mode') || 'light') {
    const next = mode === 'light' ? 'light' : 'dark';
    document.body.dataset.colorMode = next;
    document.body.classList.remove('light', 'dark');
    document.body.classList.add(next);
    localStorage.setItem('habibi.color-mode', next);
  }
  return { applyTheme, applyColorMode };
}
