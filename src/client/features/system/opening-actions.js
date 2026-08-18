import { setHtml } from '../../core/safe-dom.js';

export function createOpeningActions({ notify }) {
  async function openApp(result) {
    if (result.dataset.launching === 'true') return;
    const title = result.dataset.title || 'app';
    result.dataset.launching = 'true';
    result.disabled = true;
    result.classList.add('launching');
    const tag = result.querySelector('.result-tag');
    const originalTag = tag?.innerHTML;
    if (tag) {
      tag.classList.add('launching-tag');
      setHtml(tag, '<span class="mini-spinner" aria-hidden="true"></span><span>Opening</span>');
    }
    notify(`Opening ${title}…`);
    try {
      const response = await fetch('/api/open-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: decodeURIComponent(result.dataset.path) }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error();
      notify(`${title} is opening…`);
    } catch (_) {
      notify(`Could not open ${title}`);
    } finally {
      result.dataset.launching = 'false';
      result.disabled = false;
      result.classList.remove('launching');
      if (tag) {
        tag.classList.remove('launching-tag');
        setHtml(tag, originalTag || 'APP');
      }
    }
  }

  async function openFolder(folder) {
    const result = await fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder }),
    })
      .then((response) => response.json())
      .catch(() => ({ ok: false }));
    notify(result.ok ? `Opened ${folder}` : `Could not open ${folder}`);
  }

  return { openApp, openFolder };
}
