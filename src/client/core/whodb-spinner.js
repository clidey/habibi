// Shared WhoDB loading mark from frontend/src/components/loading.tsx (Clidey, Apache-2.0).
// Keep the geometry and animation classes aligned with that component.
const mark = `<path class="whodb-loader-mark__outline" d="M18 20 C24 34 42 63 60 63 C78 63 96 34 102 20" />
<path class="whodb-loader-mark__stem-outline" d="M60 29 V80" />
<path class="whodb-loader-mark__signal" pathLength="100" d="M18 20 C24 34 42 63 60 63" />
<path class="whodb-loader-mark__signal" pathLength="100" d="M102 20 C96 34 78 63 60 63" />
<path class="whodb-loader-mark__meet" d="M48 59.1 C52 61.6 56 63 60 63 C64 63 68 61.6 72 59.1" />
<path class="whodb-loader-mark__stem" pathLength="100" d="M60 29 V80" />
<circle class="whodb-loader-mark__ring" cx="18" cy="20" r="4" />
<circle class="whodb-loader-mark__ring" cx="102" cy="20" r="4" />
<circle class="whodb-loader-mark__node" cx="35" cy="48" r="2.5" />
<circle class="whodb-loader-mark__node" cx="85" cy="48" r="2.5" />
<circle class="whodb-loader-mark__beacon" cx="60" cy="18" r="6" />`;

/** Decorative progress mark; each loading state supplies its adjacent status text. */
export function spinner(small = false) {
  return `<svg class="whodb-loader-mark${small ? ' whodb-loader-mark--small' : ''}" viewBox="0 0 120 96" fill="none" aria-hidden="true" focusable="false">${mark}</svg>`;
}

/** Pause hidden loading animations without a timer or animation-frame loop. */
export function installSpinnerVisibility() {
  const update = () => document.documentElement.toggleAttribute('data-loading-paused', document.hidden);
  document.addEventListener('visibilitychange', update);
  update();
}
