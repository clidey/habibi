import { refreshIcons } from './core/view-helpers.js';
import { installClipboardImageBridge } from './core/clipboard-images.js';
import { initializeDemoMode } from './demo-mode.js';
import { installFileDrag } from './features/files/file-drag.js';
import { installUpdateFeature } from './features/updates/update-feature.js';
import { installAppInteractions } from './app-interactions.js';
import { installAppShortcuts } from './app-shortcuts.js';

export function installAppShell(deps) {
  const {
    input,
    defaultView,
    resultsView,
    count,
    dropDock,
    updateButton,
    notify,
    getMode,
    renderSearch,
    resultButton,
    home,
    mail,
    calendar,
    settings,
    kubernetes,
    platformActions,
    whatsapp,
    aiChat,
    resultActions,
    demoMode,
    demoScreen,
    demoEvents,
    demoMail,
    homeLayoutDefaults,
  } = deps;

  installClipboardImageBridge({ notify, onFiles: (files) => aiChat.show('', { files }) });
  installFileDrag({
    dropDock,
    notify,
    onFiles: (files) => aiChat.show('', { files }),
    onComposeMail: (path, name) => mail.showComposer('New email', { path, name }),
  });
  installUpdateFeature(updateButton);
  const keyboard = installAppInteractions({
    input,
    defaultView,
    resultsView,
    notify,
    getMode,
    onHome: home.show,
    onDismiss: home.dismiss,
    onActivity: home.markActivity,
    renderSearch,
    whatsapp,
    mail,
    platformActions,
    kubernetes,
    aiChat,
    resultActions,
    openFilePreview: deps.openFilePreview,
  });
  installAppShortcuts({
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
  });
  input.focus();
  settings.applyTheme();
  settings.applyColorMode();
  refreshIcons();
  initializeDemoMode({
    demoMode,
    demoScreen,
    homeLayoutDefaults,
    input,
    defaultView,
    resultsView,
    count,
    resultButton,
    settings,
    calendar,
    renderQuickSamples: home.renderQuickSamples,
  });
  window.__habibiResetLauncher = () => {
    settings.close();
    home.show();
    input.focus({ preventScroll: true });
  };
}
