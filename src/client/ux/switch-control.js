import { loadUx } from './ux-loader.js';

const controls = new WeakMap();
const mounted = new Set();

export function mountUxSwitches(section) {
  const inputs = [...section.querySelectorAll('[data-home-layout], #analytics-enabled, #launch-at-login, #menu-bar-icon-enabled')];
  if (!inputs.length) return;
  loadUx().then((ux) => {
    for (const input of inputs) {
      if (!input.isConnected || !ux?.mountSwitch) continue;
      const host = document.createElement('span');
      host.className = 'ux-switch-host';
      input.after(host);
      input.hidden = true;
      const control = ux.mountSwitch(host, {
        checked: input.checked,
        disabled: input.disabled,
        label: input.getAttribute('aria-label'),
        onChange(checked) {
          input.checked = checked;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
      });
      const sync = () => control.update(input.checked, input.disabled);
      input.addEventListener('change', sync);
      controls.set(input, control);
      mounted.add(control);
    }
  }).catch(() => {});
}

export function refreshUxSwitch(input) {
  controls.get(input)?.update(input.checked, input.disabled);
}

export function unmountUxSwitches() {
  for (const control of mounted) control.unmount();
  mounted.clear();
}
