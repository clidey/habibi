import { loadUx } from '../../ux/ux-loader.js';
import { nativeDaily } from '../../core/native-daily.js';
function localDate(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.valueOf())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
export async function addDailyTask({ messages, plan, notify }) {
  const name = {
    timer: 'focus',
    reminder: 'reminders',
    clipboard: 'clipboard',
    recents: 'recents',
  }[plan.kind];
  if (!name) return;
  const ux = await loadUx();
  const host = document.createElement('section');
  host.className = 'assistant-daily-card';
  messages.append(host);
  const model = {
    name,
    value: {},
    query: '',
    loading: true,
    draft:
      plan.kind === 'reminder' && plan.action === 'create'
        ? { title: plan.title, due: localDate(plan.due), notes: plan.notes }
        : undefined,
    minutes: plan.seconds ? plan.seconds / 60 : undefined,
  };
  async function load() {
    if (name === 'recents') {
      const result = await fetch('/api/recent-files').then((response) => response.json());
      if (!result.ok) throw new Error('Recent files could not be read.');
      return result;
    }
    return nativeDaily(name === 'focus' ? 'focus' : `${name}.state`);
  }
  const mounted = ux.mountDailyWorkspace(host, model, async (action, value = {}) => {
    try {
      if (action.startsWith('recent.')) {
        if (action === 'recent.open')
          await fetch('/api/open-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: value.path }),
          });
        else if (action === 'recent.attach')
          await window.__habibiNativeDroppedFiles?.([value.path]);
        else
          await fetch('/api/recent-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: action === 'recent.clear' ? 'clear' : action.slice(7),
              id: value.id,
              pinned: !value.pinned,
            }),
          });
        model.value = await load();
      } else {
        if (name === 'focus' && value.value?.action === 'start' && plan.label)
          value.value.label = plan.label;
        const result = await nativeDaily(action, value);
        if (action === 'clipboard.copy') notify('Copied to the clipboard');
        else if (action !== 'reminders.settings') model.value = result;
      }
      model.error = '';
      mounted.update({ ...model });
      return true;
    } catch (error) {
      model.error = error.message;
      mounted.update({ ...model });
      return false;
    }
  });
  try {
    model.value = await load();
  } catch (error) {
    model.error = error.message;
  }
  model.loading = false;
  mounted.update({ ...model });
  messages.scrollTop = messages.scrollHeight;
  // Native focus updates continue in chat without opening another workspace.
  if (name === 'focus') {
    const update = (event) => {
      if (!host.isConnected) {
        window.removeEventListener('habibi-focus-state', update);
        return;
      }
      model.value = event.detail;
      mounted.update({ ...model });
    };
    window.addEventListener('habibi-focus-state', update);
  }
}
