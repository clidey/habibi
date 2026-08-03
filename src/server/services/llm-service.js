const path = require('path');
const { createPiHarness } = require('../../agent/pi-harness');

const PROVIDERS = {
  ollama: { label:'Ollama', kind:'local', endpoint:'http://127.0.0.1:11434', model:'llama3.2' },
  lmstudio: { label:'LM Studio', kind:'local', endpoint:'http://127.0.0.1:1234/v1', model:'local-model' },
  openai: { label:'OpenAI', kind:'external', endpoint:'https://api.openai.com/v1', model:'gpt-4.1-mini' },
  anthropic: { label:'Anthropic', kind:'external', endpoint:'https://api.anthropic.com', model:'claude-sonnet-4-5' },
  gemini: { label:'Google Gemini', kind:'external', endpoint:'https://generativelanguage.googleapis.com/v1beta', model:'gemini-2.5-flash' },
};

function inferIntent(text = '') {
  const value = text.toLowerCase();
  if (/\bwhatsapp\b|\b(?:message|text|ping)\s+(?:a\s+)?(?:person|contact|someone|them)\b/i.test(value)) return { kind:'whatsapp_draft', label:'WhatsApp draft', detail:'Find the recipient, review the recent chat, then show a draft for approval.' };
  if (/\b(calendar|schedule|meeting|event|book|remind)\b/.test(value)) return { kind:'calendar_draft', label:'Calendar draft', detail:'Extract the time and attendees, then show an event draft for approval.' };
  if (/\b(email|gmail|mail)\b/.test(value)) return { kind:'email_draft', label:'Email draft', detail:'Prepare a reply or new email for approval.' };
  return null;
}

function createLlmService({ root, fs, spawn }) {
  const configFile = path.join(root, '.habibi', 'llm-config.json');
  const keychainService = 'Habibi LLM Provider';

  const readConfig = () => {
    try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (_) { return {}; }
  };
  const writeConfig = config => {
    fs.mkdirSync(path.dirname(configFile), { recursive:true });
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode:0o600 });
  };
  const command = (program, args, input) => new Promise(resolve => {
    const child = spawn(program, args, { stdio:[input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ ok:false, error:error.message }));
    child.on('close', code => resolve({ ok:code === 0, stdout:stdout.trim(), error:stderr.trim() }));
    if (input) child.stdin.end(input);
  });
  const keyAccount = provider => `provider:${provider}`;
  const saveKey = async (provider, apiKey) => command('security', ['add-generic-password', '-U', '-s', keychainService, '-a', keyAccount(provider), '-w', apiKey]);
  const getKey = async provider => {
    const result = await command('security', ['find-generic-password', '-s', keychainService, '-a', keyAccount(provider), '-w']);
    return result.ok ? result.stdout : '';
  };
  const piHarness = createPiHarness({ getKey });
  const configured = async () => {
    const config = readConfig();
    if (!config.provider || !PROVIDERS[config.provider]) return { ok:true, configured:false, providers:PROVIDERS };
    const provider = PROVIDERS[config.provider];
    const hasKey = provider.kind === 'local' || Boolean(await getKey(config.provider));
    return { ok:true, configured:hasKey, provider:config.provider, model:config.model || provider.model, endpoint:config.endpoint || provider.endpoint, providers:PROVIDERS };
  };
  const configure = async ({ provider, model, endpoint, apiKey }) => {
    if (!PROVIDERS[provider]) return { ok:false, error:'Unsupported provider' };
    const definition = PROVIDERS[provider];
    if (definition.kind === 'external' && !apiKey && !await getKey(provider)) return { ok:false, error:'An API key is required for this provider.' };
    if (apiKey) {
      const stored = await saveKey(provider, apiKey);
      if (!stored.ok) return { ok:false, error:'Could not save the key in your macOS Keychain.' };
    }
    writeConfig({ provider, model:(model || definition.model).trim(), endpoint:(endpoint || definition.endpoint).replace(/\/$/, ''), updatedAt:new Date().toISOString() });
    return configured();
  };
  const models = async ({ provider, endpoint }) => {
    if (!PROVIDERS[provider]) return { ok:false, models:[] };
    const base = (endpoint || PROVIDERS[provider].endpoint).replace(/\/$/, '');
    try {
      if (provider === 'ollama') {
        const response = await fetch(`${base}/api/tags`);
        const data = await response.json();
        return { ok:response.ok, models:(data.models || []).map(item => item.name).filter(Boolean) };
      }
      if (provider === 'lmstudio') {
        const response = await fetch(`${base}/models`);
        const data = await response.json();
        return { ok:response.ok, models:(data.data || []).map(item => item.id).filter(Boolean) };
      }
      return { ok:true, models:[PROVIDERS[provider].model] };
    } catch (_) { return { ok:false, models:[] }; }
  };
  const complete = async ({ messages, systemPrompt: overrideSystemPrompt } = {}) => {
    const state = await configured();
    if (!state.configured) return { ok:false, needsConfiguration:true, error:'Choose a model provider first.' };
    const config = readConfig(); const provider = config.provider; const definition = PROVIDERS[provider]; const endpoint = config.endpoint; const model = config.model;
    const intent = inferIntent(messages[messages.length - 1]?.text || messages[messages.length - 1]?.content || '');
    const defaultSystem = `You are Habibi, a concise private desktop assistant. Be helpful and direct. Format structured answers as short Markdown with real line breaks and bullets; never put an entire plan on one line. You may interpret requests across local skills such as WhatsApp, Calendar, email, files and browser context. ${intent ? `The local intent detector identified: ${intent.label}. ${intent.detail}` : ''} PRIVACY RULE: Habibi does not automatically provide you with contact names, chat history, avatars, timestamps, addresses, calendars, or other personal context. Never infer or request such details. BROWSER RULE: you have no live web-search results. Never invent listings, prices, availability, ratings, links, search results, or claims about what a website contains. When a travel or discovery request reaches you, ask only for genuinely missing criteria in one short response; Habibi will open the real search once the request is complete. CRITICAL SAFETY RULE: never claim that you sent, wrote, created, scheduled, modified, or opened anything outside this chat. For any external action, prepare a draft or plan and explicitly ask the user to review and approve it. Sending messages and creating calendar events always require a separate confirmation.`;
    const system = overrideSystemPrompt || defaultSystem;
    const supportsVision = /(?:vision|\bvl\b|llava|qwen.*vl|gpt-4o|gpt-4\.1|gemini|claude)/i.test(model);
    const attachmentNote = attachments => {
      if (!attachments?.length) return '';
      const summary = `\n\n[Attachment${attachments.length === 1 ? '' : 's'} included: ${attachments.map(item => `${item.name} (${item.mime || 'unknown type'})`).join(', ')}.${supportsVision ? '' : ' This model cannot inspect image attachment content; acknowledge that limitation and ask for relevant text or a vision-capable model if needed.'}]`;
      // Text pasted as an attachment is explicit user-provided context. It is
      // included only in that submitted turn, capped locally before any model
      // provider sees it; previous turns retain metadata rather than the text.
      const pastedText = attachments.filter(item => item.mime === 'text/plain' && typeof item.text === 'string')
        .map(item => `\n\n[Attached text: ${item.name}]\n${item.text.slice(0, 24_000)}`)
        .join('').slice(0, 48_000);
      return summary + pastedText;
    };
    const normalizedMessages = messages.slice(-20).map(({ role, text, content, attachments }) => ({ role:role === 'assistant' ? 'assistant' : 'user', content:(text || content || '') + attachmentNote(attachments), attachments:attachments || [] }));
    const payloadMessages = [{ role:'system', content:system }, ...normalizedMessages.map(({ role, content }) => ({ role, content }))];
    const lastUser = [...normalizedMessages].reverse().find(message => message.role === 'user');
    const imageAttachments = supportsVision ? (lastUser?.attachments || []).filter(item => /^image\//.test(item.mime || '') && /^data:image\//.test(item.dataUrl || '')) : [];
    try {
      let response;
      // Pi drives every text-only turn: provider abstraction, agent state and
      // tool-loop semantics are no longer hand-rolled in Habibi. Image turns
      // retain the provider-native path until Pi's attachment adapters are
      // enabled for our privacy-filtered attachment contract.
      if (!imageAttachments.length) {
        try {
          const result = await piHarness.complete({ config:{ provider, endpoint, model }, systemPrompt:system, messages:normalizedMessages });
          if (result.text) return { ok:true, text:result.text, provider, model, proposal:intent, harness:'pi' };
          console.warn('[Habibi Pi fallback]', result.error || 'agent completed without text');
        } catch (error) {
          // Some OpenAI-compatible local servers omit usage fields Pi expects
          // on a streamed completion. Preserve the agent as the normal path,
          // but make the user-facing turn resilient rather than surfacing an
          // implementation detail.
          console.warn('[Habibi Pi fallback]', error?.message || error);
        }
      }
      if (provider === 'ollama') {
        const ollamaMessages = payloadMessages.map(message => ({ ...message }));
        if (imageAttachments.length) ollamaMessages[ollamaMessages.length - 1].images = imageAttachments.map(item => item.dataUrl.split(',')[1]);
        response = await fetch(`${endpoint}/api/chat`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ model, messages:ollamaMessages, stream:false }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Ollama could not answer');
        return { ok:true, text:data.message?.content || '', provider, model, proposal:intent };
      }
      const apiKey = await getKey(provider);
      if (provider === 'anthropic') {
        const anthropicMessages = payloadMessages.slice(1).map(message => ({ ...message }));
        if (imageAttachments.length) anthropicMessages[anthropicMessages.length - 1].content = [{ type:'text', text:lastUser.content }, ...imageAttachments.map(item => ({ type:'image', source:{ type:'base64', media_type:item.mime, data:item.dataUrl.split(',')[1] } }))];
        response = await fetch(`${endpoint}/v1/messages`, { method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' }, body:JSON.stringify({ model, max_tokens:900, system, messages:anthropicMessages }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Anthropic could not answer');
        return { ok:true, text:data.content?.map(part => part.text || '').join('') || '', provider, model, proposal:intent };
      }
      if (provider === 'gemini') {
        const contents = payloadMessages.slice(1).map(message => ({ role:message.role === 'assistant' ? 'model' : 'user', parts:[{ text:message.content }] }));
        if (imageAttachments.length) contents[contents.length - 1].parts.push(...imageAttachments.map(item => ({ inlineData:{ mimeType:item.mime, data:item.dataUrl.split(',')[1] } })));
        response = await fetch(`${endpoint}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ systemInstruction:{ parts:[{ text:system }] }, contents }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Gemini could not answer');
        return { ok:true, text:data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '', provider, model, proposal:intent };
      }
      const openAiMessages = payloadMessages.map(message => ({ ...message }));
      if (imageAttachments.length) openAiMessages[openAiMessages.length - 1].content = [{ type:'text', text:lastUser.content }, ...imageAttachments.map(item => ({ type:'image_url', image_url:{ url:item.dataUrl } }))];
      response = await fetch(`${endpoint}/chat/completions`, { method:'POST', headers:{ 'Content-Type':'application/json', ...(provider === 'lmstudio' ? {} : { Authorization:`Bearer ${apiKey}` }) }, body:JSON.stringify({ model, messages:openAiMessages, temperature:0.4 }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || `${definition.label} could not answer`);
      return { ok:true, text:data.choices?.[0]?.message?.content || '', provider, model, proposal:intent };
    } catch (error) { return { ok:false, error:error.message || 'The provider is unavailable.', provider, model }; }
  };
  const route = async ({ text, context = '' }) => {
    const request = String(text || '').trim();
    const providerMatch = request.match(/^\s*(?:ask|use|open)\s+(chatgpt|claude|gemini)\s+(?:(?:to|about)\s+)?(.+)$/i);
    if (providerMatch) {
      const provider = providerMatch[1].toLowerCase();
      const original = providerMatch[2].trim();
      const refinePrompt = `You refine a request that will be sent to ${provider}. Return JSON only: {"query":"..."}. Keep the user's intent, language, technical terms, constraints and desired output; make it clear, self-contained and directly actionable. Do not invent personal context, facts, links, results, or requirements. Do not answer the request yourself.`;
      const refined = await complete({ messages:[{ role:'user', text:original }], systemPrompt:refinePrompt });
      let query = original;
      if (refined.ok) {
        try { query = String(JSON.parse(String(refined.text).replace(/^```json\s*|\s*```$/g, '').trim()).query || original).trim().slice(0, 800) || original; }
        catch (_) { /* The original request is a safe fallback. */ }
      }
      return { ok:true, action:'provider_chat', provider, query };
    }
    // Definitions, explanations, and stable how/why questions belong in the
    // private chat. Do this before asking an agent to route anything, so a
    // model cannot turn “Tell me what FOC is” into an unnecessary web search.
    const directQuestion = /^(?:tell(?:\s+me)?|explain|define|what(?:'s|\s+is|\s+are)?|who(?:\s+is|\s+are)?|why|how|compare|difference\s+between|help\s+me\s+understand)\b/i.test(request);
    const needsLiveLookup = /\b(?:latest|today|right now|current(?:ly)?|news|weather|price|prices|availability|available|near me|nearby|schedule|score|stock)\b/i.test(request);
    if (directQuestion && !needsLiveLookup) return { ok:true, action:'chat' };
    const now = new Date().toISOString().slice(0, 10);
    const systemPrompt = `You are Habibi's local action-routing agent. Decide whether the user needs real live web results. Reply with JSON only, no Markdown. Schema: {"action":"browser_search"|"chat","provider":"airbnb"|"google","query":"...","checkin":"YYYY-MM-DD"|null,"checkout":"YYYY-MM-DD"|null,"adults":number|null}. Browser search is a narrow exception: use it only for an explicit search/find/lookup request, travel/accommodation, shopping/products, venues, or a question that inherently requires current live information. Explanations, definitions, conceptual questions, technical how-tos, writing, and general advice must return chat—even if the user says “tell me” or “what is”. Use airbnb only when the user explicitly names Airbnb; otherwise use google. Derive relative dates from today's date ${now}. For browser_search, write a concise, useful, expanded search query—never merely repeat the user's words. Resolve relative dates into exact human-readable dates and include destination, intent, and useful synonyms. Example: “Find me a place to stay in St Ives next weekend” becomes query “Hotels and Airbnb stays in St Ives, United Kingdom, 7 August 2026 to 9 August 2026”, checkin “2026-08-07”, checkout “2026-08-09”. “Next weekend” means the Friday through Sunday after the coming weekend. Never invent search results, prices, availability, ratings, or links. If in doubt, return {"action":"chat"}.`;
    const result = await complete({ messages:[{ role:'user', text:`Context: ${context}\nRequest: ${request}` }], systemPrompt });
    if (!result.ok) return { ok:false, action:'chat' };
    try {
      const parsed = JSON.parse(String(result.text).replace(/^```json\s*|\s*```$/g, '').trim());
      if (parsed.action !== 'browser_search') return { ok:true, action:'chat' };
      const provider = parsed.provider === 'airbnb' ? 'airbnb' : 'google';
      const query = String(parsed.query || request).trim().slice(0, 300);
      if (!query) return { ok:true, action:'chat' };
      return { ok:true, action:'browser_search', provider, query, checkin:/^\d{4}-\d{2}-\d{2}$/.test(parsed.checkin || '') ? parsed.checkin : null, checkout:/^\d{4}-\d{2}-\d{2}$/.test(parsed.checkout || '') ? parsed.checkout : null, adults:Number.isInteger(parsed.adults) && parsed.adults > 0 ? parsed.adults : null };
    } catch (_) { return { ok:true, action:'chat' }; }
  };
  const mailSearchPlan = async query => {
    const text = String(query || '').trim().slice(0, 360);
    const fallback = { terms:text.split(/\s+/).filter(word => word.length > 1).slice(0, 8), from:'', subject:'', after:'', before:'', unread:null, source:'rules' };
    const state = await configured();
    // A mailbox query is personal data too. Never send it to a hosted model just
    // to make a search nicer; the local rules remain a good, instant fallback.
    if (!state.configured || !['ollama', 'lmstudio'].includes(state.provider) || !text) return fallback;
    const today = new Date().toISOString().slice(0, 10);
    const systemPrompt = `You translate a user's mailbox search into a safe, read-only IMAP search plan. Return JSON only: {"terms":["..."],"from":"","subject":"","after":"YYYY-MM-DD or empty","before":"YYYY-MM-DD or empty","unread":true|false|null}. Today is ${today}. Do not invent names, addresses, dates, or mailbox contents. Preserve useful words exactly. Use at most 8 short terms. The plan cannot modify, send, archive, or delete anything.`;
    const result = await complete({ messages:[{ role:'user', text }], systemPrompt });
    if (!result.ok) return fallback;
    try {
      const value = JSON.parse(String(result.text).replace(/^```json\s*|\s*```$/g, '').trim());
      const validDate = date => /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : '';
      return {
        terms:Array.isArray(value.terms) ? value.terms.map(term => String(term).trim()).filter(term => term.length > 1).slice(0, 8) : fallback.terms,
        from:String(value.from || '').trim().slice(0, 160),
        subject:String(value.subject || '').trim().slice(0, 200),
        after:validDate(value.after), before:validDate(value.before),
        unread:typeof value.unread === 'boolean' ? value.unread : null,
        source:'local-model'
      };
    } catch (_) { return fallback; }
  };
  return { configured, configure, models, complete, route, mailSearchPlan, providers:PROVIDERS };
}

module.exports = { createLlmService, PROVIDERS, inferIntent };
