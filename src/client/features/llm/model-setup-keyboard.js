export function installModelSetupKeyboard(selectProvider) {
  document.querySelector('.provider-setup').addEventListener('keydown', (event) => {
    const providerButtons = [...document.querySelectorAll('.provider-option')];
    const providerIndex = providerButtons.indexOf(document.activeElement);
    if (providerIndex >= 0 && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      providerButtons[
        (providerIndex + direction + providerButtons.length) % providerButtons.length
      ].focus();
      return;
    }
    if (providerIndex >= 0 && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      selectProvider(document.activeElement.dataset.provider);
      document.querySelector('#llm-model')?.focus();
      return;
    }
    const modelButton = document.activeElement.closest?.('#llm-model-menu button');
    if (modelButton && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const buttons = [...document.querySelectorAll('#llm-model-menu button')];
      const index = buttons.indexOf(modelButton);
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + direction + buttons.length) % buttons.length].focus();
      return;
    }
    if (modelButton && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      modelButton.click();
    }
    if (modelButton && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      document.querySelector('#llm-model-trigger')?.click();
      document.querySelector('#llm-model')?.focus();
    }
  });
}
