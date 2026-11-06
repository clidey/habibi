/** Load file mentions only when the launcher input needs them. */
export function installLauncherMentions({ input, notify, onSubmit }) {
  let pending;
  let controller;
  let submitting = false;
  const hasMention = (text) => /(?:^|\s)@/.test(text);
  async function load() {
    if (!pending) {
      const asset = '/assets/assistant-tools.bundle.js';
      pending = import(asset)
        .then((module) => module.installPathMentions(input, notify, { placement: 'launcher' }))
        .then((value) => (controller = value))
        .catch((error) => {
          pending = undefined;
          throw error;
        });
    }
    return pending;
  }
  input.addEventListener('input', () => {
    if (!hasMention(input.value) && !controller?.hasGrants()) {
      controller?.reset();
      return;
    }
    if (!controller)
      load()
        .then((value) => value.refresh())
        .catch(() => notify('The file picker could not load. Try again.'));
  });
  input.addEventListener(
    'keydown',
    (event) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
        return;
      if (controller?.isOpen()) return; // The shared picker owns selection keys first.
      if (!hasMention(input.value) && !controller?.hasGrants()) return;
      if (!controller && ['ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === 'Escape') return;
        load()
          .then((value) => value.refresh())
          .catch(() => notify('The file picker could not load. Try again.'));
        return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (submitting) return;
      const text = input.value.trim();
      if (!controller) {
        load()
          .then(async (value) => {
            await value.refresh();
            if (value.isOpen()) await value.chooseActive();
            else await submit(text, value);
          })
          .catch(() => notify('The file picker could not load. Try again.'));
        return;
      }
      submit(text, controller);
    },
    true,
  );
  async function submit(text, picker) {
    submitting = true;
    input.value = '';
    try {
      const pathGrants = await picker.capture(text);
      if (!pathGrants.length) throw new Error('Select a file or folder with @ before submitting.');
      picker.reset();
      onSubmit(text || 'Work with selected files', { pathGrants });
    } catch (error) {
      if (!input.value) input.value = text;
      notify(error.message);
    } finally {
      submitting = false;
    }
  }
  window.addEventListener('habibi-clear-launcher-mentions', () => controller?.reset());
  window.__habibiSubmitLauncherMentions = () =>
    controller?.hasGrants() && !submitting ? submit(input.value.trim(), controller) : undefined;
  // Clearing or navigating away must not leave a floating picker over another view.
  input.addEventListener('blur', (event) => {
    if (event.relatedTarget?.closest('.launcher-mention-host')) return;
    controller?.close();
  });
}
