import { chatTime, icon, refreshIcons } from './src/client/core/view-helpers.js';
import { launcherResults } from './src/client/data/launcher-results.js';
import { createResultButton } from './src/client/ui/result-button.js';
import * as features from './src/client/feature-factories.js';
import { previewFile as openFilePreview } from './src/client/features/files/file-preview.js';
import { track } from './src/client/core/analytics.js';
import * as clipboard from './src/client/core/clipboard-images.js';
import { installAppShell } from './src/client/app-shell.js';
import * as config from './src/client/app-config.js';
import { createAppServices } from './src/client/core/app-services.js';
import { getAppElements } from './src/client/app-elements.js';

const { input, defaultView, resultsView, count, updateButton, toast, dropDock } = getAppElements();
let launcherMode = null;
const { notify, requestApproval, requestNativeLockScreen } = createAppServices({ toast });
const resultButton = createResultButton({ icon, chatTime, iconNames: config.iconNames });
let home;
const showDefault = (...args) => home.show(...args);
const homeLayout = () => home.layout();
const applyHomeLayout = () => home.applyLayout();
const saveHomeLayout = (...args) => home.saveLayout(...args);
const reopenGettingStarted = () => home.reopenGettingStarted();
const { renderSearch } = features.createSearchFeature({
  input,
  defaultView,
  resultsView,
  count,
  results: launcherResults,
  resultButton,
  refreshIcons,
});
const kubernetes = features.createKubernetesFeature({
  input,
  defaultView,
  resultsView,
  count,
  onBack: showDefault,
  onOpen: () => {
    launcherMode = 'kubernetes';
  },
});
const agentSessions = features.createAgentSessionsFeature({
  input,
  defaultView,
  resultsView,
  count,
  notify,
  onBack: showDefault,
  onOpen: () => {
    launcherMode = 'agent-sessions';
  },
});
const platformActions = features.createPlatformActionsFeature({
  input,
  defaultView,
  resultsView,
  count,
  notify,
  requestApproval,
  requestNativeLockScreen,
  onBack: showDefault,
  onOpen: (mode) => {
    launcherMode = mode;
  },
});
let mail;
let modelSetup;
let intentRouter;
const calendar = features.createCalendarFeature({
  defaultView,
  resultsView,
  count,
  notify,
  requestApproval,
  applyHomeLayout,
  onBack: showDefault,
  onMailThread: (...args) => mail.showThread(...args),
  demoMode: config.demoMode,
  demoEvents: config.demoEvents,
  demoMail: config.demoMail,
});
mail = features.createMailFeature({
  input,
  defaultView,
  resultsView,
  count,
  notify,
  requestApproval,
  onHome: showDefault,
  onOpen: (mode = 'mail') => {
    launcherMode = mode;
  },
  onPreview: (path, name) => openFilePreview(path, name, notify),
});
const aiChat = features.createAiChatFeature({
  input,
  defaultView,
  resultsView,
  count,
  notify,
  calendar,
  mail,
  onHome: showDefault,
  onOpen: () => {
    launcherMode = 'habibi-chat';
  },
  openModelSetup: (options) => modelSetup.show(options),
  getIntentRouter: () => intentRouter,
  pastedImageFiles: clipboard.pastedImageFiles,
  requestNativeClipboardImage: clipboard.requestNativeClipboardImage,
});
modelSetup = features.createModelSetupFeature({
  defaultView,
  resultsView,
  count,
  onBack: showDefault,
  onChat: aiChat.show,
  onOpen: () => {
    launcherMode = 'llm-setup';
  },
});
const whatsappChatsFeature = features.createWhatsAppChatsFeature({
  input,
  resultsView,
  count,
  resultButton,
  notify,
  requestApproval,
  isActive: () => launcherMode === 'whatsapp',
  onOpen: () => {
    launcherMode = 'whatsapp';
  },
});
const whatsappSetup = features.createWhatsAppSetupFeature({
  defaultView,
  resultsView,
  count,
  onChats: whatsappChatsFeature.showChats,
  onHome: showDefault,
});
const skills = features.createSkillsFeature({
  input,
  defaultView,
  resultsView,
  count,
  notify,
  requestApproval,
  onHome: showDefault,
  onOpen: (mode) => {
    launcherMode = mode;
  },
});
intentRouter = features.createIntentRouter({
  input,
  defaultView,
  resultsView,
  count,
  notify,
  kubernetes,
  calendar,
  mail,
  whatsapp: whatsappChatsFeature,
  onChat: aiChat.show,
  onHome: showDefault,
});
const settings = features.createSettingsFeature({
  input,
  defaultView,
  resultsView,
  count,
  notify,
  homeLayout,
  saveHomeLayout,
  modelSetup,
  whatsappSetup,
  mail,
  calendar,
  onHome: showDefault,
  onOpen: () => {
    launcherMode = 'settings';
  },
  onRestartOnboarding: reopenGettingStarted,
});
home = features.createHomeController({
  input,
  defaultView,
  resultsView,
  count,
  notify,
  calendar,
  kubernetes,
  agentSessions,
  settings,
  mail,
  whatsappSetup,
  modelSetup,
  demoMode: config.demoMode,
  homeLayoutDefaults: config.homeLayoutDefaults,
  onboardingDismissedKey: config.onboardingKeys.dismissed,
  onboardingShortcutKey: config.onboardingKeys.shortcut,
  onboardingPreviewKey: config.onboardingKeys.preview,
  onOpenHome: () => {
    launcherMode = null;
  },
});
const resultActions = features.createResultActions({
  input,
  resultsView,
  notify,
  getMode: () => launcherMode,
  onHome: showDefault,
  settings,
  mail,
  whatsapp: whatsappChatsFeature,
  whatsappSetup,
  platformActions,
  kubernetes,
  agentSessions,
  calendar,
  skills,
  intentRouter,
});
installAppShell({
  input,
  defaultView,
  resultsView,
  count,
  dropDock,
  updateButton,
  notify,
  getMode: () => launcherMode,
  renderSearch,
  resultButton,
  home,
  mail,
  calendar,
  settings,
  kubernetes,
  platformActions,
  whatsapp: whatsappChatsFeature,
  aiChat,
  resultActions,
  demoMode: config.demoMode,
  demoScreen: config.demoScreen,
  demoEvents: config.demoEvents,
  demoMail: config.demoMail,
  homeLayoutDefaults: config.homeLayoutDefaults,
  openFilePreview: (path, title) => openFilePreview(path, title, notify),
});
