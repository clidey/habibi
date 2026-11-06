import { loadUx } from '../../ux/ux-loader.js';
import { fileRequest } from './api.js';
export async function installPathMentions(draft, notify, options = {}) {
  const ux = await loadUx();
  const host = document.createElement('div');
  host.className =
    options.placement === 'launcher'
      ? 'assistant-mention-host launcher-mention-host'
      : 'assistant-mention-host';
  if (options.placement === 'launcher') draft.closest('.search-row').after(host);
  else draft.before(host);
  const tagHost = options.placement === 'launcher' ? document.createElement('div') : null;
  if (tagHost) {
    tagHost.className = 'launcher-path-tags';
    draft.before(tagHost);
  }
  const model = { grants: [...(options.initialGrants || [])], open: false, items: [], active: 0 };
  let selecting;
  let sequence = 0;
  let range;
  async function select(item) {
    try {
      const { grant } = await fileRequest('grant', { path: item.path });
      if (!model.grants.some((value) => value.path === grant.path)) model.grants.push(grant);
      if (range) {
        draft.value = draft.value.slice(0, range.from) + draft.value.slice(range.to);
        draft.setSelectionRange(range.from, range.from);
      }
      model.open = false;
      render();
      draft.dispatchEvent(new Event('input', { bubbles: true }));
      draft.focus();
    } catch (error) {
      notify(error.message);
    }
  }
  function remove(item) {
    model.grants = model.grants.filter((grant) => grant.id !== item.id);
    draft.value = draft.value.replaceAll(`@"${item.path}"`, '');
    render();
    draft.dispatchEvent(new Event('input', { bubbles: true }));
    draft.focus();
  }
  const view = ux.mountPathMentions(
    host,
    model,
    (action, item) => {
      if (action === 'select') select(item);
      else remove(item);
    },
    tagHost,
  );
  function render() {
    if (options.placement === 'launcher') {
      if (model.grants.length) draft.dataset.pathMentions = String(model.grants.length);
      else delete draft.dataset.pathMentions;
    }
    view.update(model);
  }
  render();
  const refresh = async () => {
    const current = ++sequence;
    const before = draft.value.slice(0, draft.selectionStart);
    const match = before.match(/(?:^|\s)@(?:"([^"\n]*)|([^@"\n]*))$/);
    if (!match) {
      model.open = false;
      render();
      return;
    }
    const query = match[1] ?? match[2] ?? '';
    range = {
      from: before.length - match[0].length + match[0].indexOf('@'),
      to: draft.selectionStart,
    };
    try {
      const result = await fetch(`/api/file-tools/paths?q=${encodeURIComponent(query)}`).then(
        (response) => response.json(),
      );
      if (current !== sequence || !draft.isConnected) return;
      model.items = result.items || [];
      model.open = true;
      model.active = 0;
      render();
    } catch {
      model.open = false;
      render();
    }
  };
  draft.addEventListener('input', refresh);
  draft.addEventListener(
    'keydown',
    (event) => {
      if (
        event.key === 'Backspace' &&
        !event.isComposing &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        draft.selectionStart === 0 &&
        draft.selectionEnd === 0 &&
        model.grants.length
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        remove(model.grants.at(-1));
        return;
      }
      if (!model.open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        model.open = false;
        render();
      }
      if (['ArrowDown', 'ArrowUp'].includes(event.key) && model.items.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        model.active =
          (model.active + (event.key === 'ArrowDown' ? 1 : model.items.length - 1)) %
          model.items.length;
        render();
      }
      if (['Enter', 'Tab'].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (model.items.length) selecting = select(model.items[model.active]);
      }
    },
    true,
  );
  return {
    refresh,
    hasGrants: () => model.grants.length > 0,
    isOpen: () => model.open,
    async chooseActive() {
      if (model.open && model.items.length) await select(model.items[model.active]);
    },
    close() {
      ++sequence;
      model.open = false;
      render();
    },
    reset() {
      ++sequence;
      model.grants = [];
      model.open = false;
      render();
    },
    async capture(text) {
      await selecting;
      for (const match of text.matchAll(/@"([^"\n]+)"|@((?:~\/|\/)[^\s]+)/g)) {
        const target = match[1] || match[2];
        if (!model.grants.some((grant) => grant.path === target)) {
          const { grant } = await fileRequest('grant', { path: target });
          if (!model.grants.some((item) => item.path === grant.path)) model.grants.push(grant);
        }
      }
      model.open = false;
      render();
      return [...model.grants];
    },
  };
}
