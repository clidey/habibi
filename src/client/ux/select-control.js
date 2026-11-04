const controls = new WeakMap();
const mounted = new Set();

function optionState(select) {
  return [...select.options].map(option => ({
    value: option.value,
    label: option.textContent,
    disabled: option.disabled,
  }));
}

function propsFor(select) {
  return {
    value: select.value,
    disabled: select.disabled,
    options: optionState(select),
    label: select.getAttribute('aria-label') || select.labels?.[0]?.textContent.trim() || 'Select option',
    onChange(value) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      refreshUxNativeSelect(select);
    },
  };
}

export function refreshUxNativeSelect(select) {
  const item = controls.get(select);
  if (!item) return;
  item.control.update(propsFor(select));
}

function mount(select) {
  if (controls.has(select) || select.matches('.web-search-fallback, [aria-hidden="true"], [data-slot]')) return;
  const host = document.createElement('span');
  host.className = 'ux-native-select-host';
  select.after(host);
  const control = window.HabibiUx.mountNativeSelect(host, propsFor(select));
  select.hidden = true;
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const optionsObserver = new MutationObserver(() => refreshUxNativeSelect(select));
  optionsObserver.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['selected', 'disabled', 'value'] });
  select.addEventListener('change', () => refreshUxNativeSelect(select));
  const item = { select, control, optionsObserver };
  controls.set(select, item);
  mounted.add(item);
}

/** Upgrade native selects as workspaces render, retaining their value API. */
export function installUxSelectObserver() {
  if (!window.HabibiUx?.mountNativeSelect) return;
  const scan = (node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.matches('select')) mount(node);
    node.querySelectorAll('select').forEach(mount);
  };
  scan(document.body);
  const observer = new MutationObserver((mutations) => {
    for (const item of mounted) {
      if (item.select.isConnected) continue;
      item.optionsObserver.disconnect();
      item.control.unmount();
      mounted.delete(item);
    }
    for (const mutation of mutations) for (const node of mutation.addedNodes) scan(node);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
