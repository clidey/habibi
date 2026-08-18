export function installAppShortcuts({
  input,
  resultsView,
  keyboard,
  settings,
  calendar,
  home,
  mail,
  whatsapp,
  renderSearch,
  getMode,
}) {
  document.querySelector('#open-settings').onclick = settings.show;
  document.querySelector('#open-preferences').onclick = settings.show;
  window.__habibiOpenPreferences = () => settings.show();
  document.querySelector('#open-agenda').onclick = calendar.showUpcoming;
  document.querySelectorAll('[data-sample]').forEach((button) => {
    button.onclick = () => {
      input.value = button.dataset.sample;
      home.markActivity();
      renderSearch(input.value);
    };
  });

  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    const preview = document.querySelector('#quick-preview');
    if (preview && (event.key === 'Escape' || event.code === 'Space')) {
      event.preventDefault();
      preview.remove();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      home.dismiss();
      return;
    }
    if (event.metaKey && event.key === 'Enter' && document.querySelector('#open-mail-provider')) {
      event.preventDefault();
      document.querySelector('#open-mail-provider').click();
      return;
    }
    const mode = getMode();
    if (event.metaKey && event.key === 'ArrowLeft') {
      event.preventDefault();
      const back = document.querySelector('.back-button');
      if (back) return back.click();
      if (document.querySelector('#back-chats')) return whatsapp.showChats();
      if (document.querySelector('#habibi-ephemeral-chat') || mode === 'whatsapp')
        return home.show();
    }
    if (event.metaKey && event.key.toLowerCase() === 'n' && mode === 'mail') {
      event.preventDefault();
      mail.showComposer('Mail');
      return;
    }
    if (event.metaKey && event.key === 'ArrowDown' && !resultsView.classList.contains('hidden')) {
      event.preventDefault();
      keyboard.jumpToLocalFiles();
      return;
    }
    if (event.altKey && event.code === 'Space') {
      event.preventDefault();
      input.focus();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      input.focus();
    }
  });
}
