import { demoWhoDbScope, demoWhoDbApps, demoWhoDbResult } from './data/whodb-demo-fixtures.js';
import { demoEvents, demoMail } from './data/demo-fixtures.js';

/** A sealed demo: every API request receives fictional data; mutations never reach the host. */
export function installDemoApi(screen) {
  const qr = '<svg xmlns="http://www.w3.org/2000/svg" width="210" height="210"><rect width="210" height="210" fill="white"/><text x="105" y="95" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#15233f">Demo pairing code</text><text x="105" y="120" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5d687b">Connect in the real app</text></svg>';
  const accounts = [{ id: 'demo-gmail', provider: 'gmail', connected: true, label: 'Gmail', email: 'maya@example.test' }, { id: 'demo-zoho', provider: 'zoho', connected: true, label: 'Zoho Mail', email: 'team@example.test' }];
  const responses = {
    '/api/whodb/status': { ok: true, connected: screen.startsWith('whodb-'), host: 'https://demo.example.test', serverId: 'demo', servers: [{ id: 'demo', name: 'WhoDB' }] },
    '/api/whodb/scope': demoWhoDbScope,
    '/api/whodb/apps': { ok: true, apps: demoWhoDbApps },
    '/api/llm/status': { ok: true, configured: true, provider: 'ollama', model: 'llama3.2' },
    '/api/mail/status': { ok: true, providers: [{ id: 'gmail', label: 'Gmail' }, { id: 'zoho', label: 'Zoho Mail' }], accounts },
    '/api/mail/threads': { ok: true, threads: demoMail },
    '/api/mail/recent': { ok: true, threads: demoMail },
    '/api/mail/search': { ok: true, threads: demoMail, plan: { source: 'local-matching' } },
    '/api/calendars': { ok: true, calendars: ['Work', 'Personal', 'UK Holidays'] },
    '/api/openwa/status': { ok: true, session: screen === 'whatsapp-reconnecting' ? { status: 'authenticating', phone: 'demo', pushName: 'Maya Chen' } : { status: 'qr_ready' }, qrCode: screen === 'whatsapp-reconnecting' ? null : 'data:image/svg+xml;base64,' + btoa(qr) },
    '/api/whatsapp/chats': { ok: true, chats: [] },
    '/api/apps': { ok: true, apps: [] },
    '/api/files': [{ name: 'what-is-whodb.mdx', path: '/demo/Documents/what-is-whodb.mdx', folder: 'Documents', directory: '~/Documents/overview' }],
    '/api/search/status': { ok: true, indexed: 12480, roots: ['Documents', 'Desktop', 'Downloads', 'Projects'], watchers: 4, truncated: false, unavailableRoots: [] },
  };
  window.fetch = async (resource, options = {}) => {
    const url = new URL(typeof resource === 'string' ? resource : resource.url, window.location.origin);
    // Even unmatched/external requests are sealed; a demo must never contact a real provider.
    if (url.pathname === '/api/whodb/scope' && url.searchParams.get('org')) return new Response(JSON.stringify({ ...demoWhoDbScope, org: demoWhoDbScope.orgs.find((org) => org.id === url.searchParams.get('org')) || demoWhoDbScope.org }), { headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/mail/threads') {
      const provider = url.searchParams.get('provider');
      return new Response(JSON.stringify({ ok: true, threads: demoMail.filter((item) => item.accountId === provider) }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/whodb/ask') return new Response(JSON.stringify(demoWhoDbResult), { headers: { 'Content-Type': 'application/json' } });
    const data = options.method && options.method !== 'GET' ? { ok: false, error: 'This is a fictional demo. Open Habibi to use connected services.' } : responses[url.pathname] || { ok: true, events: demoEvents, accounts: [], models: [] };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}
