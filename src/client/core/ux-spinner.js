/** Loading visuals come from the published Clidey UX Spinner. */
export function spinner(small = false) {
  return (
    window.HabibiUx?.renderSpinner?.(small) || '<span role="status" aria-label="Loading">…</span>'
  );
}

/** Pause hidden animations without a timer or animation-frame loop. */
export function installSpinnerVisibility() {
  const update = () =>
    document.documentElement.toggleAttribute('data-loading-paused', document.hidden);
  document.addEventListener('visibilitychange', update);
  update();
}
