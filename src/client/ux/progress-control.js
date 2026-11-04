import { loadUx } from './ux-loader.js';

const controls = new WeakMap();

export function mountUxProgress(host) {
  loadUx().then((ux) => {
    if (!host.isConnected || !ux?.mountProgress) return;
    controls.set(host, ux.mountProgress(host, Number(host.dataset.value) || 0));
  }).catch(() => {});
}

export function updateUxProgress(host, value, visible) {
  if (!host) return;
  host.hidden = !visible;
  if (!visible) return;
  const next = Math.min(100, Math.max(0, Number(value) || 0));
  host.dataset.value = String(next);
  const fallback = host.querySelector('progress');
  if (fallback) fallback.value = next;
  controls.get(host)?.setValue(next);
}
