/**
 * Habibi's Pi-backed agent harness.
 *
 * Pi owns model transport, streaming and the tool-use loop. Habibi owns
 * identities, privacy filtering, tool policy, confirmation UX and persistence.
 * No tool in this module can make an external write.
 */
const { evaluateToolCall } = require('./harness-policy');
let runtimePromise;

async function loadRuntime() {
  runtimePromise ||= Promise.all([
    import('@earendil-works/pi-agent-core'),
    import('@earendil-works/pi-ai'),
    import('@earendil-works/pi-ai/api/openai-completions.lazy'),
    import('@earendil-works/pi-ai/api/anthropic-messages.lazy'),
    import('@earendil-works/pi-ai/api/google-generative-ai.lazy'),
  ]).then(([agent, ai, openai, anthropic, google]) => ({ ...agent, ...ai, ...openai, ...anthropic, ...google }));
  return runtimePromise;
}

const providerApi = provider => provider === 'anthropic' ? 'anthropic-messages' : provider === 'gemini' ? 'google-generative-ai' : 'openai-completions';
const providerEndpoint = (provider, endpoint) => provider === 'ollama' ? `${endpoint.replace(/\/$/, '')}/v1` : endpoint.replace(/\/$/, '');
const modelInput = model => /(?:vision|\bvl\b|llava|qwen.*vl|gpt-4o|gpt-4\.1|gpt-5|chat-latest|gemini|claude)/i.test(model) ? ['text', 'image'] : ['text'];

function approvalGate(toolName, redeemApproval) {
  const policy = evaluateToolCall({ name:toolName, redeemApproval });
  return policy.decision === 'allow' ? undefined : { block:true, reason:policy.reason };
}

function textFromMessage(message) {
  return (message?.content || []).filter(part => part.type === 'text').map(part => part.text).join('');
}

function createPiHarness({ getKey }) {
  async function complete({ config, systemPrompt, messages, tools = [] }) {
    const runtime = await loadRuntime();
    const provider = config.provider;
    const api = providerApi(provider);
    const endpoint = providerEndpoint(provider, config.endpoint);
    const apiKey = provider === 'ollama' || provider === 'lmstudio' ? '' : await getKey(provider);
    const model = {
      id: config.model,
      name: config.model,
      api,
      provider,
      baseUrl:endpoint,
      reasoning:false,
      input:modelInput(config.model),
      cost:{ input:0, output:0, cacheRead:0, cacheWrite:0 },
      contextWindow:128000,
      maxTokens:4096,
      ...(api === 'openai-completions' ? { compat:{ supportsDeveloperRole:false, supportsReasoningEffort:false } } : {})
    };
    const streams = api === 'anthropic-messages' ? runtime.anthropicMessagesApi() : api === 'google-generative-ai' ? runtime.googleGenerativeAIApi() : runtime.openAICompletionsApi();
    const models = runtime.createModels();
    models.setProvider(runtime.createProvider({
      id:provider,
      name:provider,
      baseUrl:endpoint,
      auth:{ apiKey:{ name:provider, resolve:async () => ({ auth:apiKey ? { apiKey } : {} }) } },
      models:[model],
      api:streams,
    }));
    const normalized = messages.map(message => ({ role:message.role === 'assistant' ? 'assistant' : 'user', content:message.text || message.content || '', timestamp:Date.now() }));
    const final = normalized.pop() || { role:'user', content:'', timestamp:Date.now() };
    const agent = new runtime.Agent({
      initialState:{ systemPrompt, model, messages:normalized, tools, thinkingLevel:'off' },
      streamFn:models.streamSimple.bind(models),
      // pi-agent-core requires a resolved key before it starts a turn. Local
      // OpenAI-compatible servers ignore this sentinel; hosted providers get
      // the actual value from Habibi's Keychain-backed resolver.
      getApiKey:async () => apiKey || 'habibi-local',
      toolExecution:'sequential',
      beforeToolCall:({ toolCall }) => approvalGate(toolCall.name),
    });
    let finalAssistant;
    agent.subscribe(event => { if (event.type === 'message_end' && event.message.role === 'assistant') finalAssistant = event.message; });
    await agent.prompt(final);
    finalAssistant ||= [...agent.state.messages].reverse().find(message => message.role === 'assistant');
    return { text:textFromMessage(finalAssistant), error:agent.state.errorMessage, toolEvents:[...agent.state.messages].filter(message => message.role === 'toolResult') };
  }
  return { complete, approvalGate };
}

module.exports = { createPiHarness, approvalGate };
