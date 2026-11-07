import { nativeDaily } from './native-daily.js';
import { reminderDraft } from './reminder-draft.js';
import { recentRequest, recentAction } from '../../core/recent-files.js';
import { dailyIntent } from '../../../core/daily-intent.js';

export function createDailyFeature({ input, defaultView, resultsView, count, notify, onOpen }) {
  let mounted;
  let host;
  let generation = 0;
  let model = { name: 'clipboard', value: {}, query: '', loading: true };
  const active = () => host?.isConnected && !resultsView.classList.contains('hidden');
  const render = () => {
    if (active()) mounted.update({ ...model });
  };
  async function load() {
    const current = ++generation;
    try {
      const value =
        model.name === 'recents'
          ? await recentRequest()
          : await nativeDaily(model.name === 'focus' ? 'focus' : `${model.name}.state`);
      if (current !== generation || !active()) return;
      model.value = value;
      model.error = '';
      model.loading = false;
      render();
    } catch (failure) {
      if (current === generation && active()) {
        model.loading = false;
        model.error = failure.message;
        render();
      }
    }
  }
  async function action(name, value = {}) {
    if (name === 'navigate') return show(value);
    try {
      if (name.startsWith('recent.')) {
        await recentAction(name.slice(7), value);
        if (active()) await load();
        return true;
      }
      const result = await nativeDaily(name, value);
      if (!active()) return true;
      if (name === 'reminders.settings') return true;
      if (name === 'clipboard.copy') {
        notify('Copied to the clipboard');
        return true;
      }
      model.error = '';
      model.value = result;
      render();
      return true;
    } catch (failure) {
      model.error = failure.message;
      render();
      return false;
    }
  }
  async function show(name = 'clipboard', query = '') {
    if (!['clipboard', 'reminders', 'focus', 'recents'].includes(name)) return;
    mounted?.unmount();
    ++generation;
    onOpen(name);
    input.value = '';
    input.placeholder =
      name === 'clipboard'
        ? 'Search clipboard history…'
        : name === 'recents'
          ? 'Find a recent file…'
          : name === 'reminders'
            ? 'Search reminders…'
            : 'Search anything, or ask Habibi…';
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    resultsView.replaceChildren();
    host = document.createElement('div');
    host.className = 'daily-workspace-host';
    resultsView.append(host);
    model = {
      name,
      value: {},
      query: '',
      loading: true,
      draft: name === 'reminders' ? reminderDraft(query) : undefined,
      minutes: dailyIntent(query)?.minutes,
    };
    count.textContent = `${name === 'focus' ? 'Focus timer' : name === 'recents' ? 'Recent files' : name} · on this Mac`;
    mounted = window.HabibiUx.mountDailyWorkspace(host, model, action);
    await load();
  }
  window.__habibiDailyChanged = (name) => {
    if (active() && model.name === name) load();
  };
  const previousFocus = window.__habibiFocusState;
  window.__habibiFocusState = (state) => {
    previousFocus?.(state);
    if (active() && model.name === 'focus') {
      model.value = state;
      model.loading = false;
      render();
    }
  };
  return {
    show,
    filter(query) {
      model.query = query;
      render();
    },
  };
}
