/** One keyboard policy for every launcher surface. */
export function createKeyboardController({ input, defaultView, resultsView, getMode, notify }) {
  function navigateResults(direction, enterFromInput = false) {
    const items = [...document.querySelectorAll('.result')];
    // Some screens (Mail setup, provider setup, skills) intentionally have no
    // command results. The command input must still enter their button loop.
    if (!items.length) return navigateKeyboard(direction);
    const focused = document.activeElement.closest && document.activeElement.closest('.result');
    const selectedIndex = items.findIndex(item => item.classList.contains('selected'));
    // A result may be visually preselected while the command input still owns
    // focus. Entering the list from that input must land on the first item,
    // not advance past it (the old behavior skipped mail row #2).
    const currentIndex = focused ? items.indexOf(focused) : (enterFromInput ? -1 : selectedIndex);
    const nextIndex = enterFromInput && currentIndex < 0 ? (direction < 0 ? items.length - 1 : 0) : (currentIndex + direction + items.length) % items.length;
    items.forEach(item => item.classList.remove('selected'));
    items[nextIndex].classList.add('selected');
    if (getMode() === 'whatsapp') { items[nextIndex].scrollIntoView({ block:'nearest' }); input.focus({ preventScroll:true }); }
    else items[nextIndex].focus();
  }

  function keyboardTargets() {
    const targets = [...document.querySelectorAll('#default-view:not(.hidden) button:not([disabled]), #results-view:not(.hidden) button:not([disabled])')]
      .filter(button => button.offsetParent !== null);
    if (!defaultView.classList.contains('hidden') && input.offsetParent !== null) targets.unshift(input);
    return targets;
  }

  function navigateKeyboard(direction) {
    const items = keyboardTargets();
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    const next = current < 0 ? (direction < 0 ? items.length - 1 : 0) : (current + direction + items.length) % items.length;
    items.forEach(item => item.classList.remove('selected'));
    items[next].classList.add('selected');
    items[next].focus();
  }

  function jumpToLocalFiles() {
    const files = [...document.querySelectorAll('.local-files-section .result')];
    if (!files.length) {
      if (resultsView.querySelector('.local-files-section[aria-busy="true"]')) notify('Local files are still loading');
      return;
    }
    document.querySelectorAll('.result').forEach(item => item.classList.remove('selected'));
    files[0].classList.add('selected');
    files[0].focus({ preventScroll:true });
    files[0].scrollIntoView({ block:'nearest' });
  }

  return { navigateResults, navigateKeyboard, jumpToLocalFiles };
}
