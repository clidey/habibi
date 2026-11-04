import { installUxSelectObserver } from './select-control.js';

export function initializeUx() {
  window.HabibiUx?.mountShell?.(document.querySelector('#command-card'), document.querySelector('#drop-dock'));
  installUxSelectObserver();
}
