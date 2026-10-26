import { installDemoApi } from './demo-api.js';
export { demoEvents, demoMail } from './data/demo-fixtures.js';
export const demoScreen = new URLSearchParams(window.location.search).get('demo');
export const demoMode = ['briefing', 'search', 'preferences', 'ask', 'mail', 'calendar', 'whatsapp', 'whatsapp-reconnecting', 'whodb', 'whodb-connected', 'whodb-apps', 'whodb-result'].includes(demoScreen);
if (demoMode) { document.documentElement.dataset.demoCapture = 'true'; installDemoApi(demoScreen); }

export const homeLayoutDefaults = Object.freeze({
  header: true,
  briefing: true,
  calendar: true,
  mail: true,
  suggestions: true,
  footer: true,
  focusOnly: false,
});

export const onboardingKeys = Object.freeze({
  dismissed: 'habibi.getting-started.dismissed.v1',
  shortcut: 'habibi.getting-started.shortcut-set.v1',
  preview: 'habibi.getting-started.preview.v1',
});

export const iconNames = Object.freeze({
  whatsapp: 'whatsapp',
  calendar: 'calendar-days',
  files: 'folder',
  agents: 'bot',
  gmail: 'mail',
  kubernetes: 'ship-wheel',
});
