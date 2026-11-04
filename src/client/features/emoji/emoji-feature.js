import { setHtml } from '../../core/safe-dom.js';
import { refreshIcons } from '../../core/view-helpers.js';
import { categories, createCatalog, emojiSections } from './emoji-catalog.js';
import { emojiSectionsMarkup, emojiVariantsMarkup, emojiWorkspaceMarkup } from './emoji-view.js';

const recentKey = 'habibi.emoji.recent.v1';
// macOS 26's color emoji font covers Emoji 17. Keep newer entries in the source
// catalog so they can be enabled when the system font supports them.
const supportedEmojiVersion = 17;

export function createEmojiFeature({ input, defaultView, resultsView, count, notify, onBack, onOpen }) {
  let catalog;
  let catalogPromise;
  let selected = null;
  let category = 'all';
  let query = '';
  let recent = [];
  let holdTimer;

  const page = () => resultsView.querySelector('.emoji-workspace');
  const lookup = emoji => catalog?.byEmoji.get(emoji);

  async function loadCatalog() {
    if (catalog) return catalog;
    catalogPromise ||= fetch('/assets/emoji-catalog.json').then(response => {
      if (!response.ok) throw new Error('Emoji catalog unavailable');
      return response.json();
    }).then(data => {
      if (data.version !== '18.0' || !Array.isArray(data.entries) || data.entries.length < 3900)
        throw new Error('Emoji catalog is incomplete');
      catalog = createCatalog(data.entries.filter(entry => !entry.v || Number.parseFloat(entry.v) <= supportedEmojiVersion));
      return catalog;
    }).catch(error => { catalogPromise = null; throw error; });
    return catalogPromise;
  }

  function readRecent() {
    try {
      const values = JSON.parse(localStorage.getItem(recentKey) || '[]');
      return Array.isArray(values) ? values.filter(value => typeof value === 'string' && lookup(value)).slice(0, 40) : [];
    } catch { return []; }
  }

  function syncSelection() {
    const root = page();
    if (!root) return;
    const entry = lookup(selected);
    root.querySelectorAll('.emoji-tile').forEach(button => {
      const active = button.dataset.emoji === selected;
      button.classList.toggle('selected', active);
      button.setAttribute('aria-pressed', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    root.querySelector('#emoji-detail-glyph').textContent = entry?.e || '✨';
    root.querySelector('#emoji-detail-name').textContent = entry?.n || 'Select an emoji';
    root.querySelector('#emoji-detail-meta').textContent = entry
      ? [entry.k.slice(0, 3).join(' · '), entry.g].filter(Boolean).join('  ·  ') : 'Browse or search the full collection';
    root.querySelector('#emoji-copy').disabled = !entry;
    const rootEmoji = entry?.b || entry?.e;
    root.querySelector('#emoji-variant-trigger').hidden = !rootEmoji || (catalog.variants.get(rootEmoji)?.length || 0) < 2;
    root.querySelector('#emoji-copy-label').textContent = 'Copy';
  }

  function render() {
    const root = page();
    if (!root || !catalog) return;
    const sections = emojiSections(catalog, category, query, recent);
    const visible = sections.flatMap(section => section.entries);
    if (!visible.some(entry => entry.e === selected)) selected = visible[0]?.e || null;
    setHtml(root.querySelector('#emoji-scroll'), emojiSectionsMarkup(sections, selected));
    root.querySelectorAll('[data-emoji-category]').forEach(button => {
      const active = button.dataset.emojiCategory === category;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    count.textContent = query.trim()
      ? `${visible.length} emoji found`
      : category === 'all' ? `${catalog.entries.length} emoji · on this Mac`
        : `${visible.length} ${categories.find(item => item.id === category)?.label.toLowerCase() || 'emoji'}`;
    closeVariants();
    syncSelection();
  }

  function select(emoji, focus = false) {
    if (!lookup(emoji)) return;
    selected = emoji;
    syncSelection();
    const button = [...(page()?.querySelectorAll('.emoji-tile') || [])].find(item => item.dataset.emoji === emoji);
    button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (focus) (button || input).focus({ preventScroll: true });
  }

  function closeVariants() {
    const variants = page()?.querySelector('#emoji-variants');
    if (variants) variants.hidden = true;
  }

  function openVariants(emoji = selected) {
    const root = page();
    const entry = lookup(emoji);
    const family = catalog?.variants.get(entry?.b || entry?.e);
    if (!root || !family || family.length < 2) return;
    select(emoji);
    const panel = root.querySelector('#emoji-variants');
    setHtml(panel, emojiVariantsMarkup(family, emoji));
    panel.hidden = false;
    panel.querySelector('.selected')?.focus({ preventScroll: true });
  }

  async function copySelected() {
    const emoji = selected;
    if (!lookup(emoji)) return;
    try {
      const bridge = window.webkit?.messageHandlers?.habibiNative;
      if (bridge) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { window.__habibiEmojiCopyResult = null; reject(new Error('Clipboard timed out')); }, 3000);
          window.__habibiEmojiCopyResult = ok => {
            clearTimeout(timeout);
            window.__habibiEmojiCopyResult = null;
            ok ? resolve() : reject(new Error('Clipboard unavailable'));
          };
          bridge.postMessage({ type: 'copyEmoji', emoji });
        });
      } else {
        await navigator.clipboard.writeText(emoji);
      }
      recent = [emoji, ...recent.filter(value => value !== emoji)].slice(0, 40);
      try { localStorage.setItem(recentKey, JSON.stringify(recent)); } catch { /* Copy still succeeded. */ }
      const label = page()?.querySelector('#emoji-copy-label');
      if (label) label.textContent = 'Copied!';
      notify(`${emoji} copied to clipboard`);
    } catch { notify('Could not copy emoji. Try again.'); }
  }

  function handleKey(event, fromGrid = false) {
    const root = page();
    if (!root) return false;
    const popup = root.querySelector('#emoji-variants');
    if (!popup.hidden) {
      if (event.key === 'Escape') { event.preventDefault(); closeVariants(); input.focus(); return true; }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...popup.querySelectorAll('button')];
        const current = buttons.indexOf(document.activeElement);
        buttons[(current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length]?.focus();
        return true;
      }
      return false;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.shiftKey ? openVariants() : copySelected();
      return true;
    }
    if (fromGrid && event.key === 'Escape') { event.preventDefault(); onBack(); return true; }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return false;
    event.preventDefault();
    const buttons = [...root.querySelectorAll('.emoji-tile')];
    if (!buttons.length) return true;
    const current = Math.max(0, buttons.findIndex(button => button.dataset.emoji === selected));
    const grid = buttons[current].parentElement;
    const width = buttons[current].getBoundingClientRect().width;
    const gap = Number.parseFloat(window.getComputedStyle(grid).columnGap) || 0;
    const columns = width > 0
      ? Math.max(1, Math.round((grid.clientWidth + gap) / (width + gap)))
      : Math.max(1, Math.floor((grid.clientWidth || 680) / 56));
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
    const next = Math.min(buttons.length - 1, Math.max(0, current + step));
    select(buttons[next].dataset.emoji, fromGrid);
    return true;
  }

  function filter(value) {
    query = String(value || '');
    if (query.trim()) category = 'all';
    render();
  }

  async function show() {
    onOpen();
    input.value = '';
    input.placeholder = 'Search emoji: fire, party, thanks…';
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = 'Loading emoji…';
    setHtml(resultsView, '<div class="emoji-loading">Loading the emoji collection…</div>');
    try { await loadCatalog(); } catch {
      setHtml(resultsView, '<div class="emoji-loading">Could not load the emoji collection. Search Emoji again to retry.</div>');
      return;
    }
    if (!resultsView.querySelector('.emoji-loading')) return;
    recent = readRecent();
    category = 'all';
    query = '';
    selected = recent[0] || null;
    setHtml(resultsView, emojiWorkspaceMarkup(window.__habibiNativeShortcut?.label));
    const root = page();
    root.querySelector('[data-emoji-category]')?.focus({ preventScroll: true });
    root.querySelector('.emoji-categories').addEventListener('click', event => {
      const button = event.target.closest('[data-emoji-category]');
      if (!button) return;
      category = button.dataset.emojiCategory;
      query = '';
      input.value = '';
      render();
      input.focus();
    });
    const scroll = root.querySelector('#emoji-scroll');
    scroll.addEventListener('click', event => {
      const tile = event.target.closest('.emoji-tile');
      if (tile) select(tile.dataset.emoji);
    });
    scroll.addEventListener('contextmenu', event => {
      const tile = event.target.closest('.emoji-tile');
      if (tile) { event.preventDefault(); openVariants(tile.dataset.emoji); }
    });
    scroll.addEventListener('pointerdown', event => {
      const tile = event.target.closest('.emoji-tile');
      if (tile) holdTimer = setTimeout(() => openVariants(tile.dataset.emoji), 450);
    });
    for (const name of ['pointerup', 'pointercancel', 'pointerleave'])
      scroll.addEventListener(name, () => clearTimeout(holdTimer));
    scroll.addEventListener('keydown', event => {
      if (handleKey(event, true)) event.stopPropagation();
    });
    root.querySelector('#emoji-variant-trigger').onclick = () => openVariants();
    root.querySelector('#emoji-copy').onclick = copySelected;
    root.querySelector('#emoji-variants').addEventListener('click', event => {
      const choice = event.target.closest('[data-variant]');
      if (!choice) return;
      select(choice.dataset.variant);
      closeVariants();
      input.focus();
    });
    root.querySelector('#emoji-variants').addEventListener('keydown', event => {
      if (handleKey(event, true)) event.stopPropagation();
    });
    render();
    refreshIcons();
    input.focus({ preventScroll: true });
  }

  return { show, filter, handleKey };
}
