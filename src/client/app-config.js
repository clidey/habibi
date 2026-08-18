export const demoScreen = new URLSearchParams(window.location.search).get('demo');
export const demoMode = ['briefing', 'search', 'preferences'].includes(demoScreen);
if (demoMode) document.documentElement.dataset.demoCapture = 'true';

export const demoEvents = [
  {
    id: 'demo-aurora-review',
    title: 'Project Aurora review',
    start: '2026-08-11T10:30:00.000Z',
    end: '2026-08-11T11:00:00.000Z',
    calendar: 'Work',
  },
];

export const demoMail = [
  {
    id: 'demo-aurora-design',
    accountId: 'demo-mail',
    accountEmail: 'you@example.test',
    subject: 'Re: Aurora design review',
    from: 'Maya Chen',
    timestamp: '2026-08-11T09:16:00.000Z',
    unread: true,
  },
];

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
  whatsapp: 'message-circle-more',
  calendar: 'calendar-days',
  files: 'folder',
  agents: 'bot',
  gmail: 'mail',
  kubernetes: 'ship-wheel',
});
