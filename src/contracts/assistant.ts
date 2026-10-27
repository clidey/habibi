/** Model plans select a known capability; execution stays in Habibi's existing UI and services. */
export type AssistantPlan =
  | { action: 'chat' }
  | { action: 'clarify'; question: string }
  | { action: 'open_url'; url: string }
  | { action: 'browser_search'; provider: 'google' | 'airbnb'; query: string; checkin?: string; checkout?: string; adults?: number }
  | { action: 'provider_chat'; provider: 'chatgpt' | 'claude' | 'gemini'; query: string }
  | { action: 'open_folder'; folder: string }
  | { action: 'open_app'; app: string }
  | { action: 'local_files' }
  | { action: 'mail'; mode: 'inbox' | 'search' | 'compose'; query: string; to: string; subject: string; body: string }
  | { action: 'whatsapp'; mode: 'chats' | 'search' | 'message'; target: string; instruction: string }
  | { action: 'calendar'; mode: 'upcoming' | 'draft' }
  | { action: 'whodb'; question: string }
  | { action: 'kubernetes'; query: string }
  | { action: 'system'; name: string };

export type AssistantRoute = ({ ok: true } & AssistantPlan)
  | { ok: false; action: 'chat'; error: string; needsConfiguration?: boolean };
