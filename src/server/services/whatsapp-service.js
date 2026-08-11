const path = require('path');

/**
 * Owns WhatsApp-specific state and transport. HTTP handlers pass in only their
 * request primitives, keeping OpenWA details out of the generic server host.
 */
function createWhatsAppService({ root, fs, spawn, openwaClient }) {
  let chatsCache = { value:null, at:0 };
  const pictureCache = new Map();
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
      // Chat names and message previews: readable only by this user.
      fs.mkdirSync(path.dirname(snapshotPath), { recursive:true, mode:0o700 });
      fs.writeFileSync(snapshotPath, JSON.stringify({ savedAt:Date.now(), chats }), { mode:0o600 });
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

  // Attachment payloads are base64-encoded before they reach OpenWA. Keep the
  // local boundary comfortably below OpenWA's default 50 MiB media cap while
  // still allowing a useful collection of documents in one approved send.
  const maxBodyBytes = 10 * 1024 * 1024;
  const readBody = requestToRead => new Promise((resolve, reject) => {
    let body = '';
    requestToRead.on('data', chunk => {
      body += chunk;
      if (body.length > maxBodyBytes) { requestToRead.destroy(); reject(new Error('Request body too large')); }
    });
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
      if (chatsCache.value && Date.now() - chatsCache.at < 60_000) return json(response, { ok:true, chats:chatsCache.value, cached:true });
      return withReady(response, json, session => request(`/api/sessions/${encodeURIComponent(session.id)}/chats?limit=100`).then(async chats => {
        const named = dedupeChats(chats);
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
        const { chatId, text = '', attachments = [], approvalToken } = JSON.parse(await readBody(httpRequest));
        const trimmedText = String(text).trim();
        const normalizedAttachments = Array.isArray(attachments) ? attachments.slice(0, 5).map(attachment => {
          const name = String(attachment?.name || 'Attachment').replace(/[\\/:\0]/g, '-').slice(0, 255) || 'Attachment';
          const mime = String(attachment?.mime || 'application/octet-stream').slice(0, 120);
          const dataUrl = String(attachment?.dataUrl || '');
          const match = dataUrl.match(/^data:([\w.+/-]+);base64,([A-Za-z0-9+/=]+)$/);
          const base64 = match?.[2] || '';
          const bytes = Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
          return match && match[1] === mime ? { name, mime, base64, bytes } : null;
        }).filter(Boolean) : [];
        if (!chatId || (!trimmedText && !normalizedAttachments.length) || trimmedText.length > 4096) return json(response, { ok:false, error:'Invalid message' });
        if (Array.isArray(attachments) && attachments.length !== normalizedAttachments.length) return json(response, { ok:false, error:'One or more attachments are invalid' });
        const approvalPayload = { chatId:String(chatId), text:trimmedText, attachments:normalizedAttachments.map(({ name, mime, bytes }) => ({ name, mime, bytes })) };
        if (!requiresApproval({ token:approvalToken, action:'whatsapp.send', payload:approvalPayload })) return json(response, { ok:false, error:'Sending needs explicit approval' });
        return withReady(response, json, async session => {
          const sent = [];
          if (trimmedText && !normalizedAttachments.length) sent.push(await request(`/api/sessions/${encodeURIComponent(session.id)}/messages/send-text`, { method:'POST', body:JSON.stringify({ chatId, text:trimmedText }) }));
          for (let index = 0; index < normalizedAttachments.length; index += 1) {
            const attachment = normalizedAttachments[index];
            sent.push(await request(`/api/sessions/${encodeURIComponent(session.id)}/messages/send-document`, {
              method:'POST',
              body:JSON.stringify({ chatId, name:undefined, mime:undefined, bytes:undefined, base64:attachment.base64, mimetype:attachment.mime, filename:attachment.name, caption:index === 0 ? trimmedText || undefined : undefined }),
            }));
          }
          json(response, { ok:true, message:sent.at(-1), sent });
        });
      } catch (error) { return json(response, { ok:false, error:error?.message || 'Invalid message' }); }
    }
    return false;
  }

  return { handle, dedupeChats, hasUsableRecents };
}

module.exports = { createWhatsAppService };
