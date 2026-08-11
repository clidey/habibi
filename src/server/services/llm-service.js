const path = require('path');

const PROVIDERS = {
  ollama: { label:'Ollama', kind:'local', endpoint:'http://127.0.0.1:11434', model:'llama3.2' },
  lmstudio: { label:'LM Studio', kind:'local', endpoint:'http://127.0.0.1:1234/v1', model:'local-model' },
  openai: { label:'OpenAI', kind:'external', endpoint:'https://api.openai.com/v1', model:'chat-latest' },
  anthropic: { label:'Anthropic', kind:'external', endpoint:'https://api.anthropic.com', model:'claude-sonnet-4-5' },
  gemini: { label:'Google Gemini', kind:'external', endpoint:'https://generativelanguage.googleapis.com/v1beta', model:'gemini-2.5-flash' },
};

/**
 * Resolves the base URL to talk to a provider.
 *
 * A hosted provider's endpoint is always the pinned value from PROVIDERS: the
 * request carries a Keychain API key, so honouring a caller-supplied endpoint
 * would let one config call redirect the key to an arbitrary host. Local
 * providers may be moved, but only to a loopback address — they are meant to be
 * another process on this Mac, not a route off it.
 */
function resolveEndpoint(provider, requested) {
  const definition = PROVIDERS[provider];
  if (!definition) return '';
  const pinned = definition.endpoint.replace(/\/$/, '');
  if (definition.kind !== 'local' || !requested) return pinned;
  try {
    const url = new URL(String(requested));
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
    if ((url.protocol === 'http:' || url.protocol === 'https:') && loopback) return String(requested).replace(/\/$/, '');
  } catch (_) { /* Fall through to the pinned default. */ }
  return pinned;
}

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
    fs.mkdirSync(path.dirname(configFile), { recursive:true, mode:0o700 });
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
  // The secret goes in over stdin, not as `-w <value>`: process arguments are
  // readable by any local process through `ps` for the lifetime of the call, and
  // `security` itself documents `-w` as insecure. Passing `-w` last makes it
  // prompt, and it asks for the value twice.
  const saveKey = async (provider, apiKey) => command('security', ['add-generic-password', '-U', '-s', keychainService, '-a', keyAccount(provider), '-w'], `${apiKey}\n${apiKey}\n`);
  const getKey = async provider => {
    const result = await command('security', ['find-generic-password', '-s', keychainService, '-a', keyAccount(provider), '-w']);
    return result.ok ? result.stdout : '';
  };
  const validateOpenAi = async ({ apiKey, model }) => {
    try {
      const response = await fetch(`${PROVIDERS.openai.endpoint}/models/${encodeURIComponent(model)}`, {
        headers:{ Authorization:`Bearer ${apiKey}` }
      });
      if (response.ok) return null;
      if (response.status === 401 || response.status === 403) return 'OpenAI rejected that API key. Create an API key in the OpenAI platform and try again.';
      if (response.status === 429) return 'OpenAI accepted the key, but the API account has no available quota or is rate-limited. Check API billing and usage limits, then try again.';
      if (response.status === 404) return `This OpenAI API key cannot use the “${model}” model. Choose another model and try again.`;
      return 'OpenAI could not verify this key and model. Check your API project permissions and try again.';
    } catch (_) {
      return 'Could not reach OpenAI to verify the key. Check your internet connection and try again.';
    }
  };
  // Provider SDKs account for most of the server's idle memory. Status and
  // configuration routes need none of them, so create Pi only for an actual
  // completion and keep it warm after first use.
  let piHarness;
  const getPiHarness = () => {
    if (!piHarness) {
      const { createPiHarness } = require('../../agent/pi-harness');
      piHarness = createPiHarness({ getKey });
    }
    return piHarness;
  };
  const configured = async () => {
    const config = readConfig();
    if (!config.provider || !PROVIDERS[config.provider]) return { ok:true, configured:false, providers:PROVIDERS };
    const provider = PROVIDERS[config.provider];
    const hasKey = provider.kind === 'local' || Boolean(await getKey(config.provider));
    // Re-resolved on read, not just on write: a config file poisoned before this
    // guard existed must not keep redirecting requests that carry an API key.
    return { ok:true, configured:hasKey, provider:config.provider, model:config.model || provider.model, endpoint:resolveEndpoint(config.provider, config.endpoint), providers:PROVIDERS };
  };
  const configure = async ({ provider, model, endpoint, apiKey }) => {
    if (!PROVIDERS[provider]) return { ok:false, error:'Unsupported provider' };
    const definition = PROVIDERS[provider];
    const selectedModel = typeof model === 'string' && model.trim() ? model.trim() : definition.model;
    const suppliedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (definition.kind === 'external' && !suppliedKey && !await getKey(provider)) return { ok:false, error:'An API key is required for this provider.' };
    if (provider === 'openai' && suppliedKey) {
      const error = await validateOpenAi({ apiKey:suppliedKey, model:selectedModel });
      if (error) return { ok:false, error };
    }
    if (suppliedKey) {
      const stored = await saveKey(provider, suppliedKey);
      if (!stored.ok) return { ok:false, error:'Could not save the key in your macOS Keychain.' };
    }
    writeConfig({ provider, model:selectedModel, endpoint:resolveEndpoint(provider, endpoint), updatedAt:new Date().toISOString() });
    return configured();
  };
  const models = async ({ provider, endpoint, apiKey } = {}) => {
    if (!PROVIDERS[provider]) return { ok:false, models:[] };
    const base = resolveEndpoint(provider, endpoint);
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
      const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : await getKey(provider);
      if (!key) return { ok:false, models:[] };
      if (provider === 'openai') {
        const response = await fetch(`${base}/models`, { headers:{ Authorization:`Bearer ${key}` } });
        const data = await response.json();
        return { ok:response.ok, models:(data.data || []).map(item => item.id).filter(Boolean).sort() };
      }
      if (provider === 'anthropic') {
        const response = await fetch(`${base}/v1/models`, { headers:{ 'x-api-key':key, 'anthropic-version':'2023-06-01' } });
        const data = await response.json();
        return { ok:response.ok, models:(data.data || []).map(item => item.id).filter(Boolean).sort() };
      }
      if (provider === 'gemini') {
        const response = await fetch(`${base}/models?key=${encodeURIComponent(key)}`);
        const data = await response.json();
        return { ok:response.ok, models:(data.models || []).filter(item => !item.supportedGenerationMethods || item.supportedGenerationMethods.includes('generateContent')).map(item => String(item.name || '').replace(/^models\//, '')).filter(Boolean).sort() };
      }
      return { ok:true, models:[PROVIDERS[provider].model] };
    } catch (_) { return { ok:false, models:[] }; }
  };
  const complete = async ({ messages, systemPrompt: overrideSystemPrompt } = {}) => {
    const state = await configured();
    if (!state.configured) return { ok:false, needsConfiguration:true, error:'Choose a model provider first.' };
    const config = readConfig(); const provider = config.provider; const definition = PROVIDERS[provider]; const endpoint = resolveEndpoint(provider, config.endpoint); const model = config.model;
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
          const result = await getPiHarness().complete({ config:{ provider, endpoint, model }, systemPrompt:system, messages:normalizedMessages });
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
    const systemPrompt = `You are Habibi's local action-routing agent. Decide whether the user needs real live web results. Reply with JSON only, no Markdown. Schema: {"action":"browser_search"|"chat","provider":"airbnb"|"google","query":"...","checkin":"YYYY-MM-DD"|null,"checkout":"YYYY-MM-DD"|null,"adults":number|null}. Browser search is a narrow exception: use it only for an explicit search/find/lookup request, travel/accommodation, shopping/products, venues, or a question that inherently requires current live information. A request about the user's own files, folders, documents, downloads, or archives must return chat because Habibi's local capability loop handles it; never send it to a browser search. Explanations, definitions, conceptual questions, technical how-tos, writing, and general advice must return chat—even if the user says “tell me” or “what is”. Use airbnb only when the user explicitly names Airbnb; otherwise use google. Derive relative dates from today's date ${now}. For browser_search, write a concise, useful, expanded search query—never merely repeat the user's words. Resolve relative dates into exact human-readable dates and include destination, intent, and useful synonyms. Example: “Find me a place to stay in St Ives next weekend” becomes query “Hotels and Airbnb stays in St Ives, United Kingdom, 7 August 2026 to 9 August 2026”, checkin “2026-08-07”, checkout “2026-08-09”. “Next weekend” means the Friday through Sunday after the coming weekend. Never invent search results, prices, availability, ratings, or links. If in doubt, return {"action":"chat"}.`;
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
  const planFileInvestigation = async ({ history = [] }) => {
    const state = await configured();
    const latestUserText = history.filter(turn => turn.role === 'user').at(-1)?.text || '';
    const contextualFallback = () => {
      const stop = new Set(['give','show','find','search','locate','open','me','my','the','a','an','ones','one','from','last','night','yesterday','today','latest','recent','newest','did','i','please','file','files','folder','folders']);
      const turns = history.filter(turn => turn.role === 'user').map(turn => String(turn.text || ''));
      const query = [...turns].reverse().map(text => text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || []).map(tokens => tokens.filter(token => !stop.has(token)).map(token => token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token).filter(token => token.length >= 3).join(' ')).find(Boolean);
      const asksForFiles = /\b(?:find|search|show|give|locate|open|latest|recent|yesterday|last night|files?|folders?)\b/i.test(turns.join(' '));
      return asksForFiles && query ? { phase:'search', queries:[query] } : null;
    };
    // Personal filenames and conversation context are only sent to a model
    // running on this Mac. A hosted provider never receives this route.
    if (!state.configured || !['ollama', 'lmstudio'].includes(state.provider)) return contextualFallback() || { phase:'not_applicable' };
    const systemPrompt = `You are Habibi's private local file-investigation agent. Decide from the conversation whether the user wants Habibi to find local files. Return JSON only: {"phase":"not_applicable"|"clarify"|"search","question":"...","queries":["..."]}. Return not_applicable for ordinary questions or tasks that are not about finding local files. For a vague local-file request, ask exactly one focused clarification in the user's language. A broad category alone is not enough to search: when the user has supplied no discriminating detail such as a date, issuer, country, person, project, document phrase, or filename fragment, return clarify. Once you have enough context, return search with 1-3 short filename/topic queries. Do not use conversational filler in queries, do not invent names, and never claim you found a file. The next agent step will search filenames locally.`;
    const result = await complete({ messages:history, systemPrompt });
    if (!result.ok) return contextualFallback() || { phase:'not_applicable' };
    try {
      const plan = JSON.parse(String(result.text).replace(/^```json\s*|\s*```$/g, '').trim());
      if (plan.phase === 'not_applicable') return contextualFallback() || { phase:'not_applicable' };
      if (plan.phase === 'search' && Array.isArray(plan.queries)) {
        const planned = plan.queries.map(query => String(query).replace(/[^a-zA-Z0-9 ._\-]/g, '').trim())
          // A planner may never create a year/date that was not supplied by
          // the user. Preserve ordinary query expansion, but strip invented
          // four-digit years from its tool input.
          .map(query => query.replace(/\b(?:19|20)\d{2}\b/g, year => latestUserText.includes(year) ? year : '').replace(/\s+/g, ' ').trim())
          .filter(query => query.length >= 2);
        // Acronyms and compact identifiers are strong filename evidence. The
        // runner probes them verbatim alongside the agent's semantic queries;
        // this is generic tool discipline, not a domain-specific rule.
        const literalProbes = (latestUserText.match(/\b[A-Z][A-Z0-9_-]{1,}\b/g) || []).map(value => value.trim());
        const queries = [...literalProbes, ...planned].filter((query, index, all) => all.findIndex(value => value.toLowerCase() === query.toLowerCase()) === index).slice(0, 3);
        if (queries.length) return { phase:'search', queries };
      }
      const question = String(plan.question || '').trim().slice(0, 320);
      return question ? { phase:'clarify', question } : (contextualFallback() || { phase:'not_applicable' });
    } catch (_) { return contextualFallback() || { phase:'not_applicable' }; }
  };
  const rankFileCandidates = async ({ history = [], candidates = [] }) => {
    if (!candidates.length) return { ids:[], summary:'' };
    const state = await configured();
    if (!state.configured || !['ollama', 'lmstudio'].includes(state.provider)) return { ids:candidates.map(file => file.path) };
    const candidateText = candidates.map(file => ({ id:file.path, name:file.name, folder:file.folder, directory:file.directory })).slice(0, 18);
    const systemPrompt = `You are Habibi's local file-investigation reviewer. Rank the provided local filename candidates against the user's request. Return JSON only: {"ids":["exact candidate id",...],"summary":"short factual sentence"}. Rank only supplied ids. Do not invent file contents or claim certainty. If none looks relevant, return an empty ids list and ask for one useful refinement in summary.`;
    const result = await complete({ messages:[...history, { role:'user', text:`Candidates to review locally:\n${JSON.stringify(candidateText)}` }], systemPrompt });
    if (!result.ok) return { ids:candidates.map(file => file.path) };
    try {
      const ranked = JSON.parse(String(result.text).replace(/^```json\s*|\s*```$/g, '').trim());
      const allowed = new Set(candidates.map(file => file.path));
      return { ids:Array.isArray(ranked.ids) ? ranked.ids.map(String).filter(id => allowed.has(id)).slice(0, 8) : [], summary:String(ranked.summary || '').trim().slice(0, 300) };
    } catch (_) { return { ids:candidates.map(file => file.path) }; }
  };
  return { configured, configure, models, complete, route, mailSearchPlan, planFileInvestigation, rankFileCandidates, providers:PROVIDERS };
}

module.exports = { createLlmService, PROVIDERS, inferIntent };
