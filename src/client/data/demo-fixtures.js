/** Fictional, fixed examples. No desktop, account, or connector data is used. */
export const demoEvents = [
  { id: 'demo-time', title: 'British Summer Time ends', start: '2026-10-25T00:00:00', end: '2026-10-26T00:00:00', calendar: 'UK Holidays', allDay: true },
  { id: 'demo-review', title: 'Demo with Maya Chen', start: '2026-10-26T10:00:00', end: '2026-10-26T10:45:00', calendar: 'Work' },
  { id: 'demo-design', title: 'Clidey design review', start: '2026-10-26T14:30:00', end: '2026-10-26T15:30:00', calendar: 'Work' },
  { id: 'demo-standup', title: 'Standup', start: '2026-10-27T09:00:00', end: '2026-10-27T09:15:00', calendar: 'Work' },
  { id: 'demo-halloween', title: 'Halloween', start: '2026-10-31T00:00:00', end: '2026-11-01T00:00:00', calendar: 'UK Holidays', allDay: true },
];
export const demoMail = [
  { id: 'demo-invoice', accountId: 'demo-gmail', accountEmail: 'maya@example.test', from: 'Northstar Hosting', subject: 'Your October invoice is ready', snippet: 'Your October invoice is ready to review. Payment is collected on Monday.', timestamp: '2026-10-24T14:10:00', unread: true },
  { id: 'demo-agenda', accountId: 'demo-gmail', accountEmail: 'maya@example.test', from: 'Maya Chen', subject: 'Demo agenda for Monday', snippet: 'Three things to cover: ontology view, app builder, and pricing.', timestamp: '2026-10-24T11:48:00', unread: true },
  { id: 'demo-release', accountId: 'demo-zoho', accountEmail: 'team@example.test', from: 'GitHub', subject: '[clidey/whodb] Release v0.92 published', snippet: 'The latest release includes the ontology explorer.', timestamp: '2026-10-24T09:30:00', unread: true },
  { id: 'demo-tax', accountId: 'demo-zoho', accountEmail: 'team@example.test', from: 'Zoho Books', subject: 'Q3 VAT summary is ready', snippet: 'Your quarterly VAT return is ready to review.', timestamp: '2026-10-23T16:00:00', unread: true },
];
