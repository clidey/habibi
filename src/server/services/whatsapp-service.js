const path = require('path');

/**
 * Owns WhatsApp-specific state and transport. HTTP handlers pass in only their
 * request primitives, keeping OpenWA details out of the generic server host.
 */
function createWhatsAppService({ root, fs, spawn, openwaClient }) {
  let chatsCache = { value:null, at:0 };
  let browserRecents = { chats:[], at:0 };
  const pictureCache = new Map();
  const contactNameCache = new Map();
  let contactLookupAt = 0;
  const snapshotPath = path.join(root, '.habibi', 'whatsapp-recents.json');

  const phoneDigits = value => String(value || '').replace(/\D/g, '');
  const isPhoneLabel = value => /^\+?\d[\d\s()-]{6,}$/.test(String(value || '').trim());
  const sessionState = () => openwaClient.sessionState();
  const request = (route, options) => openwaClient.request(route, options);

  const readSnapshot = () => {
    try {
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      return Array.isArray(snapshot.chats) && snapshot.chats.length ? snapshot : null;
    } catch (_) { return null; }
  };

  const hasUsableRecents = chats => {
    const visible = (chats || []).filter(chat => chat.kind !== 'status' && !chat.archived);
    return visible.length >= 5 && visible.filter(chat => Number(chat.timestamp) > 0).length >= 5;
  };

  const saveSnapshot = chats => {
    if (!hasUsableRecents(chats)) return;
    try {
      fs.mkdirSync(path.dirname(snapshotPath), { recursive:true });
      fs.writeFileSync(snapshotPath, JSON.stringify({ savedAt:Date.now(), chats }));
    } catch (_) { /* A live session remains usable when disk is unavailable. */ }
  };

  const dedupeChats = chats => {
    const byId = new Map();
    for (const chat of chats || []) {
      const id = String(chat.id || '');
      if (!id) continue;
      const previous = byId.get(id);
      if (!previous) { byId.set(id, chat); continue; }
      const newest = Number(chat.timestamp || 0) >= Number(previous.timestamp || 0) ? chat : previous;
      const older = newest === chat ? previous : chat;
      byId.set(id, {
        ...older,
        ...newest,
        name:isPhoneLabel(newest.name) && !isPhoneLabel(older.name) ? older.name : newest.name,
        avatar:newest.avatar || older.avatar,
        unreadCount:Math.max(Number(newest.unreadCount || 0), Number(older.unreadCount || 0)),
      });
    }
    return [...byId.values()];
  };

  // OpenWA's live history uses `fromMe`; its persisted message collection uses
  // `direction`. Habibi exposes one stable UI contract regardless of source.
  const normalizeHistory = messages => (Array.isArray(messages) ? messages : messages?.messages || messages?.items || []).map(message => ({
    ...message,
    direction: message.direction || (message.fromMe ? 'outgoing' : 'incoming'),
    metadata: message.metadata || (message.media ? { media:message.media } : undefined),
  }));

  const resolveLocalContactNames = async numbers => {
    const wanted = [...new Set(numbers.map(phoneDigits).filter(number => number.length >= 7))];
    if (!wanted.length) return new Map();
    const fresh = Date.now() - contactLookupAt < 5 * 60_000;
    const unresolved = wanted.filter(number => !fresh || !contactNameCache.has(number));
    if (unresolved.length) {
      const script = `const contacts = Application('Contacts'); const wanted = ${JSON.stringify(unresolved)}; const digits = value => String(value || '').replace(/\\D/g, ''); const matches = {}; for (const person of contacts.people()) { const name = person.name(); for (const phone of person.phones()) { const value = digits(phone.value()); for (const target of wanted) { if (value === target || (value.length >= 10 && target.length >= 10 && value.slice(-10) === target.slice(-10))) { if (!matches[target]) matches[target] = name; } } } } JSON.stringify(matches);`;
      try {
        const output = await new Promise((resolve, reject) => {
          const task = spawn('osascript', ['-l', 'JavaScript', '-e', script]);
          let stdout = ''; let stderr = '';
          task.stdout.on('data', chunk => { stdout += chunk; });
          task.stderr.on('data', chunk => { stderr += chunk; });
          task.on('error', reject);
          task.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || 'Contacts lookup failed')));
        });
        const matches = JSON.parse(String(output));
        unresolved.forEach(number => contactNameCache.set(number, matches[number] || null));
      } catch (_) {
        unresolved.forEach(number => contactNameCache.set(number, null));
      }
      contactLookupAt = Date.now();
    }
    return new Map(wanted.map(number => [number, contactNameCache.get(number) || null]));
  };

  const enrichNames = async chats => {
    const names = await resolveLocalContactNames(chats.filter(chat => isPhoneLabel(chat.name)).map(chat => phoneDigits(chat.id || chat.name)));
    return chats.map(chat => {
      const localName = isPhoneLabel(chat.name) ? names.get(phoneDigits(chat.id || chat.name)) : null;
      return localName ? { ...chat, name:localName } : chat;
    });
  };

  const warmPictures = async (session, ids) => {
    const missing = ids.filter(id => !pictureCache.get(id));
    if (!missing.length) return;
    try {
      const result = await request(`/api/sessions/${encodeURIComponent(session.id)}/contacts/profile-pictures?ids=${encodeURIComponent(missing.join(','))}`);
      const pictures = result?.pictures || result || {};
      missing.forEach(id => { if (pictures[id]) pictureCache.set(id, pictures[id]); });
    } catch (_) { /* Avatars are optional enrichment. */ }
  };

  const withReady = async (response, json, action) => {
    try {
      const { session } = await sessionState();
      if (!session || session.status !== 'ready') return json(response, { ok:false, error:'WhatsApp is not connected' });
      return action(session);
    } catch (_) { return json(response, { ok:false, error:'WhatsApp is unavailable' }); }
  };

  const readBody = requestToRead => new Promise((resolve, reject) => {
    let body = '';
    requestToRead.on('data', chunk => { body += chunk; });
    requestToRead.on('error', reject);
    requestToRead.on('end', () => resolve(body));
  });

  async function handle({ request: httpRequest, response, url, json, safeJsonValue, requiresApproval = () => false }) {
    if (url.pathname === '/api/openwa/status' && httpRequest.method === 'GET') {
      return sessionState().then(state => json(response, { ok:true, ...state })).catch(() => json(response, { ok:false }));
    }
    if (url.pathname === '/api/openwa/connect' && httpRequest.method === 'POST') {
      return openwaClient.ensureSession().then(() => new Promise(resolve => setTimeout(resolve, 700))).then(sessionState)
        .then(state => json(response, { ok:true, ...state })).catch(error => json(response, { ok:false, error:error.message }));
    }
    if (url.pathname === '/api/whatsapp/chats' && httpRequest.method === 'GET') {
      if (browserRecents.chats.length && Date.now() - browserRecents.at < 120_000) return json(response, { ok:true, chats:browserRecents.chats, source:'whatsapp-web' });
      if (chatsCache.value && Date.now() - chatsCache.at < 60_000) return json(response, { ok:true, chats:chatsCache.value, cached:true });
      return withReady(response, json, session => request(`/api/sessions/${encodeURIComponent(session.id)}/chats?limit=100`).then(async chats => {
        const named = await enrichNames(dedupeChats(chats));
        saveSnapshot(named);
        const snapshot = readSnapshot();
        const resolved = hasUsableRecents(named) ? named : snapshot?.chats || named;
        chatsCache = { value:resolved, at:Date.now() };
        void warmPictures(session, resolved.slice(0, 20).map(chat => chat.id));
        json(response, { ok:true, chats:resolved, cached:false, source:hasUsableRecents(named) ? 'openwa' : snapshot ? 'snapshot' : 'openwa' });
      }));
    }
    if (url.pathname === '/api/whatsapp/contacts' && httpRequest.method === 'GET') {
      const query = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 80);
      return withReady(response, json, session => request(`/api/sessions/${encodeURIComponent(session.id)}/contacts?limit=1000`).then(contacts => {
        const matches = (contacts || []).filter(contact => `${contact.name || ''} ${contact.pushName || ''} ${contact.notify || ''} ${contact.id || ''}`.toLowerCase().includes(query)).slice(0, 20);
        json(response, { ok:true, contacts:matches });
      }));
    }
    if (url.pathname === '/api/whatsapp/browser-recents' && httpRequest.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'POST, OPTIONS', 'Access-Control-Allow-Headers':'Content-Type' });
      return response.end();
    }
    if (url.pathname === '/api/whatsapp/browser-recents' && httpRequest.method === 'POST') {
      response.setHeader('Access-Control-Allow-Origin', '*');
      try {
        const { chats } = JSON.parse(await readBody(httpRequest));
        if (!Array.isArray(chats)) throw new Error('Invalid recents');
        browserRecents = { chats:chats.slice(0, 100).map(chat => ({ id:String(chat.id || chat.name), name:String(chat.name || ''), lastMessage:String(chat.lastMessage || ''), timestamp:Number(chat.timestamp || 0), unreadCount:Number(chat.unreadCount || 0), avatar:typeof chat.avatar === 'string' ? chat.avatar : '', kind:chat.kind || 'individual' })), at:Date.now() };
        return json(response, { ok:true });
      } catch (_) { return json(response, { ok:false }); }
    }
    if (url.pathname === '/api/whatsapp/history' && httpRequest.method === 'GET') {
      const chatId = url.searchParams.get('chatId');
      if (!chatId) return json(response, { ok:false, error:'Missing chat' });
      return withReady(response, json, async session => {
        const id = encodeURIComponent(chatId);
        // The paginated collection is OpenWA's persisted store and can lag a
        // connected device. Prefer the engine-backed endpoint: it returns the
        // latest WhatsApp-visible messages for this chat. Fall back only when
        // the engine cannot provide live history.
        let messages;
        try {
          messages = await request(`/api/sessions/${encodeURIComponent(session.id)}/messages/${id}/history?limit=40`);
        } catch (_) {
          messages = await request(`/api/sessions/${encodeURIComponent(session.id)}/messages?chatId=${id}&limit=40`);
        }
        return json(response, { ok:true, messages:safeJsonValue(normalizeHistory(messages)) });
      });
    }
    if (url.pathname === '/api/whatsapp/profile-pictures' && httpRequest.method === 'GET') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 50);
      if (!ids.length) return json(response, { ok:true, pictures:{} });
      const pictures = Object.fromEntries(ids.map(id => [id, pictureCache.get(id) || null]));
      sessionState().then(({ session }) => { if (session?.status === 'ready') void warmPictures(session, ids); }).catch(() => {});
      return json(response, { ok:true, pictures:{ pictures } });
    }
    if (url.pathname === '/api/whatsapp/send' && httpRequest.method === 'POST') {
      try {
        const { chatId, text, approvalToken } = JSON.parse(await readBody(httpRequest));
        if (!chatId || !text || text.length > 4096) return json(response, { ok:false, error:'Invalid message' });
        if (!requiresApproval({ token:approvalToken, action:'whatsapp.send', payload:{ chatId:String(chatId), text:String(text) } })) return json(response, { ok:false, error:'Sending needs explicit approval' });
        return withReady(response, json, session => request(`/api/sessions/${encodeURIComponent(session.id)}/messages/send-text`, { method:'POST', body:JSON.stringify({ chatId, text }) })
          .then(message => json(response, { ok:true, message })));
      } catch (_) { return json(response, { ok:false, error:'Invalid message' }); }
    }
    return false;
  }

  return { handle, dedupeChats, hasUsableRecents };
}

module.exports = { createWhatsAppService };
