const path = require('path');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const sanitizeHtml = require('sanitize-html');
const nodemailer = require('nodemailer');

// The same app password that authenticates IMAP also authenticates SMTP for
// both providers, so sending needs no separate credential flow — just the
// provider's outbound host next to the inbound one already in PROVIDERS.
const SMTP = {
  gmail: { host:'smtp.gmail.com', port:465 },
  zoho: { host:'smtppro.zoho.com', port:465 },
};

const PROVIDERS = {
  gmail: {
    label:'Gmail', auth:'https://accounts.google.com/o/oauth2/v2/auth', token:'https://oauth2.googleapis.com/token',
    scopes:['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
  },
  zoho: {
    label:'Zoho Mail', auth:'https://accounts.zoho.com/oauth/v2/auth', token:'https://accounts.zoho.com/oauth/v2/token',
    scopes:['ZohoMail.accounts.READ', 'ZohoMail.messages.READ', 'ZohoMail.messages.CREATE'],
  },
};

// Mail clients commonly put the whole quoted conversation in `text/plain`.
// Treat the quoted headers as structure, rather than displaying one large MIME-ish
// blob. This deliberately preserves the message prose while dropping visual noise
// such as inline-image ids, link wrappers, warning banners and legal footers.
const cleanMailText = value => String(value || '')
  .replace(/\r\n/g, '\n')
  .replace(/^\s*\[cid:[^\]]+\].*$/gmi, '')
  .replace(/<https?:\/\/[^>\s]+>/g, '')
  .replace(/^Note:\s*This email is received from an external sender[^\n]*(?:\n(?!\s*\n)[^\n]*)*/gmi, '')
  .replace(/^This message \(including any attachments\)[\s\S]*$/gmi, '')
  .replace(/^This message and any attachments are confidential[\s\S]*$/gmi, '')
  .replace(/^_{10,}\s*$/gm, '')
  .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
  .trim();

const addressFrom = value => String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || '';
const conversationSubject = value => String(value || '').replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();

function safeEmailHtml(value) {
  // Only render the current email's HTML. Quoted mail is already split into
  // separate plain-text bubbles below, so it must not be duplicated here.
  let current = String(value || '')
    .replace(/<hr\b[^>]*>[\s\S]*$/i, '')
    .replace(/(?:<br\s*\/?>(?:\s|&nbsp;|<br\s*\/?>)*){2,}\s*(?:From:|On\s.+?wrote:)[\s\S]*$/i, '');
  // HTML mail often wraps a reply header in a nest of spans/divs instead of
  // placing it directly after a <br>. Cutting at its first visible `From:` is
  // safe: sanitizer will close any remaining open tags for us.
  const replyAt = current.search(/(?:<[^>]+>\s*){0,6}From:\s/i);
  if (replyAt >= 0) current = current.slice(0, replyAt);
  current = current.replace(/={3,}\s*Forwarded message\s*={3,}/gi, '');
  const sanitized = sanitizeHtml(current, {
    allowedTags:['a', 'b', 'blockquote', 'br', 'div', 'em', 'i', 'li', 'ol', 'p', 'span', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul'],
    allowedAttributes:{ a:['href', 'title'], td:['colspan', 'rowspan'], th:['colspan', 'rowspan'], '*':['style'] },
    allowedSchemes:['http', 'https', 'mailto'],
    allowedSchemesByTag:{ a:['http', 'https', 'mailto'] },
    allowedStyles:{
      '*': {
        'font-size':[/^\d+(?:px|pt|em|rem|%)$/i],
        'font-weight':[/^(?:normal|bold|[1-9]00)$/i],
        'font-style':[/^(?:normal|italic)$/i],
        'text-align':[/^(?:left|right|center)$/i],
        'text-decoration':[/^(?:none|underline)$/i],
      },
    },
    transformTags:{ a:sanitizeHtml.simpleTransform('a', { target:'_blank', rel:'noopener noreferrer nofollow' }) },
  });
  // Outlook/Zoho signatures often encode blank paragraphs as <div><br></div>.
  // They create huge visual gaps in a compact launcher, so collapse them while
  // retaining one meaningful line break between prose blocks.
  return sanitized
    .replace(/<(?:div|p)(?:\s[^>]*)?>\s*(?:<br\s*\/?>\s*)+<\/(?:div|p)>/gi, '')
    .replace(/(?:<br\s*\/?>\s*){3,}/gi, '<br><br>')
    .trim();
}

function sectionHeaders(section) {
  const normalized = String(section || '').replace(/^\s*_{10,}\s*\n*/i, '').trim();
  if (!/^From:\s*/i.test(normalized)) return { from:'', to:'', sent:'', body:normalized };
  const boundary = normalized.search(/\n\s*\n/);
  if (boundary < 0) return { from:normalized.match(/^From:\s*(.+)$/im)?.[1]?.trim() || '', to:'', sent:'', body:'' };
  const headers = normalized.slice(0, boundary);
  return {
    from:headers.match(/^From:\s*(.+)$/im)?.[1]?.trim() || '',
    to:headers.match(/^To:\s*(.+)$/im)?.[1]?.trim() || '',
    sent:headers.match(/^(?:Sent|Date):\s*(.+)$/im)?.[1]?.trim() || '',
    body:normalized.slice(boundary).trim(),
  };
}

function splitMailThread(body, latestFrom, ownEmail, fallbackTimestamp = 0, firstHtml = '') {
  // A separator may have an empty line before `From:`, or the client may omit it.
  const sections = String(body || '').replace(/\r\n/g, '\n').split(/\n(?:\s*_{10,}\s*\n\s*)?(?=From:\s)/i);
  const messages = sections.map((section, index) => {
    const parsed = sectionHeaders(section);
    const from = parsed.from || (index === 0 ? latestFrom : 'Unknown sender');
    const content = cleanMailText(parsed.body);
    const sender = addressFrom(from);
    const parsedTime = parsed.sent ? Date.parse(parsed.sent) : NaN;
    return {
      from,
      to:parsed.to || '',
      sent:parsed.sent || '',
      body:content.replace(/={3,}\s*Forwarded message\s*={3,}/gi, '').trim(),
      html:index === 0 ? firstHtml : '',
      direction:sender && sender === String(ownEmail || '').toLowerCase() ? 'outgoing' : 'incoming',
      timestamp:Number.isFinite(parsedTime) ? parsedTime : Math.max(0, fallbackTimestamp - index),
    };
  }).filter(item => item.body);
  // A forwarded email is followed by a normal From: header. Attach that sender
  // to the preceding bubble so the client can render a concise forward marker.
  return messages.map((message, index) => ({
    ...message,
    forwardedFrom:/forwarded message/i.test(sections[index] || '') ? messages[index + 1]?.from || '' : '',
    forwardedTo:/forwarded message/i.test(sections[index] || '') ? messages[index + 1]?.to || '' : '',
  }));
}

const dedupeMessages = messages => {
  const seen = new Set();
  return messages.filter(message => {
    const key = `${addressFrom(message.from)}:${message.body.replace(/\s+/g, ' ').trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
};

function sentMailboxPath(mailboxes) {
  return mailboxes.find(mailbox => {
    const special = Array.isArray(mailbox.specialUse) ? mailbox.specialUse.join(' ') : String(mailbox.specialUse || '');
    return /\\Sent/i.test(special) || /^(sent|sent items|sent mail)$/i.test(String(mailbox.path || ''));
  })?.path || '';
}

function createMailService({ root, fs, spawn }) {
  const configPath = path.join(root, '.habibi', 'mail-providers.json');
  const keychainService = 'Habibi Mail';
  const pending = new Map();
  const read = () => { try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { return {}; } };
  const write = value => { fs.mkdirSync(path.dirname(configPath), { recursive:true, mode:0o700 }); fs.writeFileSync(configPath, JSON.stringify(value, null, 2), { mode:0o600 }); };
  const accountId = (provider, email) => `${provider}:${String(email || '').trim().toLowerCase()}`;
  const accountsFrom = config => {
    const current = Object.entries(config.accounts || {}).map(([id, value]) => ({ id, ...value }));
    // Read pre-multi-account settings too; they remain usable until the account
    // is next connected, when it is stored in the new accounts collection.
    const legacy = Object.entries(PROVIDERS).flatMap(([provider]) => config[provider]?.imap ? [{ id:provider, provider, imap:config[provider].imap, legacy:true }] : []);
    return [...current, ...legacy].filter(account => account.provider && account.imap?.email);
  };
  const findAccount = id => accountsFrom(read()).find(account => account.id === id) || null;
  const command = (program, args, input) => new Promise(resolve => { const child = spawn(program, args, { stdio:[input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }); let stdout=''; child.stdout.on('data', chunk => { stdout += chunk; }); child.on('error', () => resolve({ ok:false })); child.on('close', code => resolve({ ok:code === 0, stdout:stdout.trim() })); if (input) child.stdin.end(input); });
  // Secrets go in over stdin rather than as `-w <value>`: process arguments are
  // readable by any local process through `ps` for the lifetime of the call, and
  // `security` itself documents `-w` as insecure. Passing `-w` last makes it
  // prompt, and it asks for the value twice.
  const saveRefresh = (provider, token) => command('security', ['add-generic-password', '-U', '-s', keychainService, '-a', `refresh:${provider}`, '-w'], `${token}\n${token}\n`);
  const getRefresh = async provider => { const result = await command('security', ['find-generic-password', '-s', keychainService, '-a', `refresh:${provider}`, '-w']); return result.ok ? result.stdout : ''; };
  const saveSecret = (account, secret) => command('security', ['add-generic-password', '-U', '-s', keychainService, '-a', account, '-w'], `${secret}\n${secret}\n`);
  const getSecret = async account => { const result = await command('security', ['find-generic-password', '-s', keychainService, '-a', account, '-w']); return result.ok ? result.stdout : ''; };
  const status = async () => {
    const config = read();
    const accounts = await Promise.all(accountsFrom(config).map(async account => ({
      id:account.id, provider:account.provider, label:PROVIDERS[account.provider]?.label || account.provider,
      email:account.imap.email, connected:Boolean(await getSecret(`imap:${account.id}`)) || (account.legacy && Boolean(await getSecret(`imap:${account.provider}`))), transport:'imap',
    })));
    const providers = Object.entries(PROVIDERS).map(([id, definition]) => ({ id, label:definition.label, configured:Boolean(config[id]?.clientId && config[id]?.clientSecret) }));
    return { ok:true, providers, accounts };
  };
  const configure = ({ provider, clientId, clientSecret, redirectUri }) => {
    if (!PROVIDERS[provider] || !clientId || !clientSecret) return { ok:false, error:'Client ID and client secret are required.' };
    const config = read(); config[provider] = { clientId:String(clientId).trim(), clientSecret:String(clientSecret).trim(), redirectUri:String(redirectUri || 'http://127.0.0.1:4173/api/mail/oauth/callback').trim() }; write(config);
    return { ok:true };
  };
  const configureImap = async ({ provider, email, password, host, port = 993 }) => {
    if (!PROVIDERS[provider] || !email || !password) return { ok:false, error:'Email address and app password are required.' };
    const defaults = provider === 'gmail' ? 'imap.gmail.com' : 'imappro.zoho.com';
    const imap = { email:String(email).trim(), host:String(host || defaults).trim(), port:Number(port) || 993 };
    const client = new ImapFlow({ host:imap.host, port:imap.port, secure:true, auth:{ user:imap.email, pass:String(password).replace(/\s+/g, '') }, logger:false });
    try { await client.connect(); await client.logout(); }
    catch (error) { await client.logout().catch(() => {}); return { ok:false, error:`IMAP login failed: ${error.message || 'check IMAP access, server, and app password.'}` }; }
    const id = accountId(provider, imap.email);
    const config = read(); config.accounts = config.accounts || {};
    if (String(config[provider]?.imap?.email || '').toLowerCase() === imap.email.toLowerCase()) delete config[provider];
    config.accounts[id] = { provider, imap, createdAt:config.accounts[id]?.createdAt || new Date().toISOString() }; write(config);
    const saved = await saveSecret(`imap:${id}`, password.replace(/\s+/g, ''));
    return saved.ok ? { ok:true, account:{ id, provider, email:imap.email } } : { ok:false, error:'Could not save the app password in macOS Keychain.' };
  };
  const remove = async id => {
    const account = findAccount(id);
    if (!account) return { ok:false, error:'Unknown mail account.' };
    const config = read();
    if (account.legacy) delete config[account.provider]; else delete config.accounts?.[id];
    write(config);
    await command('security', ['delete-generic-password', '-s', keychainService, '-a', `imap:${id}`]);
    if (account.legacy) await command('security', ['delete-generic-password', '-s', keychainService, '-a', `imap:${account.provider}`]);
    return { ok:true };
  };
  const threads = async id => {
    const account = findAccount(id); const imap = account?.imap;
    const password = await getSecret(`imap:${id}`) || (account?.legacy ? await getSecret(`imap:${account.provider}`) : '');
    if (!imap || !password) return { ok:false, error:'Connect this account with IMAP first.', threads:[] };
    const client = new ImapFlow({ host:imap.host, port:imap.port, secure:true, auth:{ user:imap.email, pass:password }, logger:false });
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const total = client.mailbox.exists || 0; const start = Math.max(1, total - 49); const rows = [];
        for await (const message of client.fetch(`${start}:*`, { uid:true, envelope:true, flags:true, internalDate:true })) rows.push({ id:String(message.uid), accountId:account.id, provider:account.provider, accountEmail:imap.email, subject:message.envelope?.subject || '(No subject)', from:message.envelope?.from?.[0]?.address || '', preview:'', timestamp:message.internalDate?.getTime() || 0, unread:!message.flags?.has('\\Seen') });
        return { ok:true, threads:rows.sort((a, b) => b.timestamp - a.timestamp) };
      } finally { lock.release(); }
    } catch (error) { return { ok:false, error:error.message || 'Could not connect to IMAP.', threads:[] }; }
    finally { await client.logout().catch(() => {}); }
  };
  const searchCriteria = plan => {
    const terms = (plan.terms || []).map(value => String(value).trim()).filter(Boolean).slice(0, 8);
    const alternatives = [];
    for (const term of terms) alternatives.push({ subject:term }, { from:term }, { to:term }, { body:term });
    const criteria = alternatives.length > 1 ? { or:alternatives } : (alternatives[0] || { all:true });
    if (plan.from) criteria.from = String(plan.from).trim();
    if (plan.subject) criteria.subject = String(plan.subject).trim();
    if (plan.after) criteria.since = new Date(`${plan.after}T00:00:00`);
    if (plan.before) criteria.before = new Date(`${plan.before}T00:00:00`);
    if (typeof plan.unread === 'boolean') criteria.seen = !plan.unread;
    return criteria;
  };
  const scoreSearchResult = (thread, plan) => {
    const haystack = `${thread.subject} ${thread.from} ${thread.to || ''}`.toLowerCase();
    const terms = [plan.from, plan.subject, ...(plan.terms || [])].map(value => String(value || '').toLowerCase()).filter(Boolean);
    const matches = terms.reduce((score, term) => score + (haystack.includes(term) ? 12 : 0), 0);
    const subjectBoost = (plan.terms || []).some(term => String(thread.subject || '').toLowerCase().includes(String(term).toLowerCase())) ? 8 : 0;
    return matches + subjectBoost + Math.min(6, Math.max(0, (thread.timestamp || 0) / 1e13));
  };
  const searchAccount = async (id, plan) => {
    const account = findAccount(id); const imap = account?.imap;
    const password = await getSecret(`imap:${id}`) || (account?.legacy ? await getSecret(`imap:${account.provider}`) : '');
    if (!imap || !password) return { ok:false, error:'Connect this account with IMAP first.', threads:[] };
    const client = new ImapFlow({ host:imap.host, port:imap.port, secure:true, auth:{ user:imap.email, pass:password }, logger:false });
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const ids = await client.search(searchCriteria(plan), { uid:true });
        // IMAP returns UIDs in mailbox order. Pull the newest matches first,
        // then rank subject/sender hits locally without exposing any mail to a model.
        const candidates = ids.slice(-120).reverse();
        const rows = [];
        for await (const message of client.fetch(candidates, { uid:true, envelope:true, flags:true, internalDate:true }, { uid:true })) {
          rows.push({ id:String(message.uid), accountId:account.id, provider:account.provider, accountEmail:imap.email, subject:message.envelope?.subject || '(No subject)', from:message.envelope?.from?.[0]?.address || '', to:message.envelope?.to?.[0]?.address || '', preview:'', timestamp:message.internalDate?.getTime() || 0, unread:!message.flags?.has('\\Seen') });
        }
        return { ok:true, threads:rows.sort((left, right) => scoreSearchResult(right, plan) - scoreSearchResult(left, plan) || right.timestamp - left.timestamp) };
      } finally { lock.release(); }
    } catch (error) { return { ok:false, error:error.message || 'Could not search this IMAP inbox.', threads:[] }; }
    finally { await client.logout().catch(() => {}); }
  };
  const search = async ({ query, provider = 'all', plan = {} }) => {
    const normalized = {
      terms:Array.isArray(plan.terms) ? plan.terms.map(value => String(value).trim()).filter(Boolean).slice(0, 8) : String(query || '').split(/\s+/).filter(word => word.length > 1).slice(0, 8),
      from:String(plan.from || '').trim(), subject:String(plan.subject || '').trim(), after:String(plan.after || '').trim(), before:String(plan.before || '').trim(), unread:typeof plan.unread === 'boolean' ? plan.unread : null,
      source:plan.source === 'local-model' ? 'local-model' : 'rules',
    };
    const accounts = provider && provider !== 'all' ? [findAccount(provider)].filter(Boolean) : accountsFrom(read());
    if (!accounts.length) return { ok:true, threads:[], plan:normalized };
    const results = await Promise.all(accounts.map(account => searchAccount(account.id, normalized)));
    const errors = results.filter(result => !result.ok).map(result => result.error).filter(Boolean);
    return { ok:results.some(result => result.ok), threads:results.flatMap(result => result.threads || []).sort((left, right) => scoreSearchResult(right, normalized) - scoreSearchResult(left, normalized) || right.timestamp - left.timestamp).slice(0, 80), plan:normalized, error:errors[0] || '' };
  };
  const recent = async ({ provider, hours = 4 }) => {
    if (provider === 'all') {
      const accounts = accountsFrom(read());
      const results = await Promise.all(accounts.map(account => threads(account.id)));
      const merged = results.flatMap(result => result.threads || []).sort((a, b) => b.timestamp - a.timestamp);
      const windowMs = Math.min(24, Math.max(1, Number(hours) || 4)) * 60 * 60 * 1000;
      return { ok:true, threads:merged.filter(thread => thread.timestamp >= Date.now() - windowMs) };
    }
    const inbox = await threads(provider);
    const windowMs = Math.min(24, Math.max(1, Number(hours) || 4)) * 60 * 60 * 1000;
    const since = Date.now() - windowMs;
    return { ...inbox, threads:(inbox.threads || []).filter(thread => thread.timestamp >= since) };
  };
  const message = async ({ provider, uid }) => {
    const account = findAccount(provider); const imap = account?.imap; const password = await getSecret(`imap:${provider}`) || (account?.legacy ? await getSecret(`imap:${account.provider}`) : '');
    if (!imap || !password || !/^\d+$/.test(String(uid))) return { ok:false, error:'Mail account or message is unavailable.' };
    const client = new ImapFlow({ host:imap.host, port:imap.port, secure:true, auth:{ user:imap.email, pass:password }, logger:false });
    try {
      await client.connect(); const lock = await client.getMailboxLock('INBOX'); let item;
      try {
        item = await client.fetchOne(String(uid), { uid:true, envelope:true, source:true, internalDate:true }, { uid:true });
      } finally { lock.release(); }
      if (!item) return { ok:false, error:'Message no longer exists.' };

      const parsed = await simpleParser(item.source || Buffer.alloc(0), { skipImageLinks:true, skipTextToHtml:true });
      const subject = parsed.subject || item.envelope?.subject || '(No subject)';
      const body = String(parsed.text || '').replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
      const timestamp = item.internalDate?.getTime() || 0;
      const from = parsed.from?.text || item.envelope?.from?.[0]?.address || '';
      const messages = splitMailThread(body || '(No readable message body)', from, imap.email, timestamp, safeEmailHtml(parsed.html));
      const attachments = (parsed.attachments || []).map(attachment => ({ filename:attachment.filename || 'Attachment', contentType:attachment.contentType || 'file', size:attachment.size || 0 })).slice(0, 12);

      // IMAP stores our replies in a separate Sent mailbox. Read only recent
      // messages with the same normalized subject, then merge them into this
      // visual conversation. This is how the UI can show a real sent reply even
      // when the selected inbox email has not yet quoted it back.
      const sentPath = sentMailboxPath(await client.list());
      if (sentPath) {
        const sentLock = await client.getMailboxLock(sentPath);
        try {
          const total = client.mailbox.exists || 0;
          const start = Math.max(1, total - 149);
          for await (const sent of client.fetch(`${start}:*`, { envelope:true, source:true, internalDate:true })) {
            if (conversationSubject(sent.envelope?.subject) !== conversationSubject(subject)) continue;
            const sentParsed = await simpleParser(sent.source || Buffer.alloc(0), { skipImageLinks:true, skipTextToHtml:true });
            const sentParts = splitMailThread(String(sentParsed.text || ''), sentParsed.from?.text || imap.email, imap.email, sent.internalDate?.getTime() || 0, safeEmailHtml(sentParsed.html));
            // The first part is the actual message we sent; later parts are its
            // quoted history and have already been collected from the inbox.
            if (sentParts[0]) messages.push({ ...sentParts[0], direction:'outgoing', timestamp:sent.internalDate?.getTime() || sentParts[0].timestamp });
          }
        } finally { sentLock.release(); }
      }
      return { ok:true, message:{ id:String(item.uid), accountId:account.id, provider:account.provider, accountEmail:imap.email, messageId:parsed.messageId || '', subject, from, to:parsed.to?.text || '', timestamp, messages:dedupeMessages(messages), attachments } };
    } catch (error) { return { ok:false, error:error.message || 'Could not load the message.' }; }
    finally { await client.logout().catch(() => {}); }
  };
  const send = async ({ provider, to, subject, body }) => {
    const account = findAccount(provider); const imap = account?.imap;
    const address = String(to || '').trim();
    if (!imap || !account) return { ok:false, error:'Connect a mail account first.' };
    if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { ok:false, error:'Enter a valid recipient address.' };
    if (!String(body || '').trim()) return { ok:false, error:'Write a message before sending.' };
    const smtp = SMTP[account.provider];
    if (!smtp) return { ok:false, error:'Sending is not supported for this provider yet.' };
    const password = await getSecret(`imap:${account.id}`) || (account.legacy ? await getSecret(`imap:${account.provider}`) : '');
    if (!password) return { ok:false, error:'Connect this account with IMAP first.' };
    const transport = nodemailer.createTransport({ host:smtp.host, port:smtp.port, secure:true, auth:{ user:imap.email, pass:password } });
    try {
      const info = await transport.sendMail({ from:imap.email, to:address, subject:String(subject || '').trim() || '(No subject)', text:String(body) });
      return { ok:true, messageId:info.messageId || '' };
    } catch (error) { return { ok:false, error:error.message || 'Could not send this email.' }; }
    finally { transport.close(); }
  };
  const authorize = provider => {
    const config = read()[provider]; const definition = PROVIDERS[provider];
    if (!definition || !config?.clientId || !config?.clientSecret) return { ok:false, error:'Configure this mail provider first.' };
    const state = crypto.randomUUID(); pending.set(state, { provider, expiresAt:Date.now() + 10 * 60_000 });
    const params = new URLSearchParams({ client_id:config.clientId, redirect_uri:config.redirectUri, response_type:'code', access_type:'offline', prompt:'consent', state, scope:definition.scopes.join(provider === 'zoho' ? ',' : ' ') });
    return { ok:true, url:`${definition.auth}?${params}` };
  };
  const webUrl = ({ provider, subject, messageId }) => {
    const kind = findAccount(provider)?.provider || provider;
    if (kind === 'gmail') {
      const query = messageId ? `rfc822msgid:${String(messageId).replace(/[<>]/g, '')}` : `subject:"${String(subject || '').slice(0, 180)}"`;
      return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
    }
    if (kind === 'zoho') return 'https://mail.zoho.com/zm/';
    return '';
  };
  const callback = async ({ code, state }) => {
    const request = pending.get(state); pending.delete(state);
    if (!request || request.expiresAt < Date.now()) return { ok:false, error:'This connection request expired.' };
    const config = read()[request.provider]; const definition = PROVIDERS[request.provider];
    const body = new URLSearchParams({ grant_type:'authorization_code', code, client_id:config.clientId, client_secret:config.clientSecret, redirect_uri:config.redirectUri });
    const response = await fetch(definition.token, { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body });
    const token = await response.json();
    if (!response.ok || !token.refresh_token) return { ok:false, error:token.error_description || token.error || 'The provider did not return a refresh token.' };
    const stored = await saveRefresh(request.provider, token.refresh_token);
    return stored.ok ? { ok:true, provider:request.provider } : { ok:false, error:'Could not save the token in macOS Keychain.' };
  };
  return { status, configure, configureImap, remove, threads, search, recent, message, send, authorize, callback, webUrl, providers:PROVIDERS };
}

module.exports = { createMailService };
