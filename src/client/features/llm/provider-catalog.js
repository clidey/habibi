/** Provider defaults are UI metadata only; credentials stay in the OS keychain. */
export const llmProviders = {
  ollama:{ label:'Ollama', description:'Run models directly on this Mac', kind:'local', endpoint:'http://127.0.0.1:11434', model:'llama3.2' },
  lmstudio:{ label:'LM Studio', description:'Use your local LM Studio server', kind:'local', endpoint:'http://127.0.0.1:1234/v1', model:'local-model' },
  openai:{ label:'OpenAI', description:'ChatGPT models through your own API key', kind:'external', endpoint:'https://api.openai.com/v1', model:'gpt-4.1-mini' },
  anthropic:{ label:'Anthropic', description:'Claude through your own API key', kind:'external', endpoint:'https://api.anthropic.com', model:'claude-sonnet-4-5' },
  gemini:{ label:'Google Gemini', description:'Gemini through your own API key', kind:'external', endpoint:'https://generativelanguage.googleapis.com/v1beta', model:'gemini-2.5-flash' },
};
