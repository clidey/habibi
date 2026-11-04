import { getWebSearchProvider, setWebSearchProvider, webSearchProviders } from '../../core/web-search-provider.js';
import { loadUx } from '../../ux/ux-loader.js';
import { setHtml } from '../../core/safe-dom.js';

let mountedControl;

export function closeWebSearchSettings() {
  mountedControl?.unmount();
  mountedControl = undefined;
}

/** Mounts the shared Clidey UX Select when Settings becomes visible. */
export function installWebSearchSettings(target) {
  closeWebSearchSettings();
  const section = document.createElement('section');
  section.className = 'settings-section web-search-settings';
  setHtml(section, '<div class="appearance-heading"><span class="briefing-heading">05 / WEB SEARCH</span><small>Used by Habibi, separate from your browser setting.</small></div><div class="web-search-control"><span id="web-search-label">Default search engine</span><div id="web-search-control-root" class="web-search-select"></div></div>');
  target.append(section);
  const host = section.querySelector('#web-search-control-root');
  const fallback = document.createElement('select');
  fallback.className = 'web-search-fallback';
  fallback.setAttribute('aria-labelledby', 'web-search-label');
  for (const provider of webSearchProviders) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.name;
    fallback.append(option);
  }
  fallback.value = getWebSearchProvider();
  fallback.onchange = () => setWebSearchProvider(fallback.value);
  host.append(fallback);
  loadUx().then((ux) => {
    if (!section.isConnected || !ux?.mountWebSearchSelect) return;
    mountedControl = ux.mountWebSearchSelect(host, {
      value: getWebSearchProvider(),
      providers: webSearchProviders,
      onChange: setWebSearchProvider,
    });
  }).catch(() => {});
}
