import type { AssistantPlan, AssistantRoute } from '../../contracts/assistant';
import { requestedBrowserUrl } from '../../core/browser-url';
import { NAMED_FOLDERS } from '../../core/named-folders';

const text = (value: unknown, limit = 500): string => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const date = (value: unknown): string | undefined => {
  const valueText = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueText)) return undefined;
  const parsed = new Date(`${valueText}T12:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === valueText ? valueText : undefined;
};
const clarification = (question: string): AssistantPlan => ({ action: 'clarify', question });
const systemActions = ['settings', 'applications', 'sleep', 'restart', 'shutdown', 'lock', 'darkMode', 'emptyTrash', 'quitApps', 'forceQuitApps'];

export function normalizeAssistantPlan(value: unknown, request: string): AssistantPlan {
  const plan = record(value);
  switch (plan.action) {
    case 'chat': return { action: 'chat' };
    case 'clarify': return clarification(text(plan.question, 320) || 'What would you like me to open or find?');
    case 'open_url': {
      const url = requestedBrowserUrl(request, plan.url, { allowNamedWebsite: true });
      return url ? { action: 'open_url', url } : clarification('Which website address should I open?');
    }
    case 'browser_search': {
      const query = text(plan.query, 800);
      if (!query) return clarification('What or where should I search?');
      const checkin = date(plan.checkin);
      const checkout = date(plan.checkout);
      if (checkin && checkout && checkout <= checkin) return clarification('What check-out date should I use after check-in?');
      return { action: 'browser_search', provider: plan.provider === 'airbnb' ? 'airbnb' : 'google', query,
        ...(checkin ? { checkin } : {}), ...(checkout ? { checkout } : {}),
        ...(Number.isInteger(plan.adults) && Number(plan.adults) > 0 && Number(plan.adults) <= 30 ? { adults: Number(plan.adults) } : {}) };
    }
    case 'provider_chat': {
      const provider = text(plan.provider).toLowerCase();
      return ['chatgpt', 'claude', 'gemini'].includes(provider) && text(plan.query)
        ? { action: 'provider_chat', provider: provider as 'chatgpt' | 'claude' | 'gemini', query: text(plan.query, 800) }
        : clarification('Which assistant and request should I open?');
    }
    case 'open_folder': {
      const folder = Object.keys(NAMED_FOLDERS).find(name => name.toLowerCase() === text(plan.folder).toLowerCase());
      return folder ? { action: 'open_folder', folder } : clarification(`Which folder should I open: ${Object.keys(NAMED_FOLDERS).join(', ')}?`);
    }
    case 'open_app': return text(plan.app) ? { action: 'open_app', app: text(plan.app, 160) } : clarification('Which application should I open?');
    case 'local_files': return { action: 'local_files' };
    case 'mail': {
      const recipient = text(plan.to, 200);
      const to = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) && request.toLowerCase().includes(recipient.toLowerCase()) ? recipient : '';
      return { action: 'mail', mode: plan.mode === 'compose' ? 'compose' : plan.mode === 'search' ? 'search' : 'inbox', query: text(plan.query), to, subject: text(plan.subject, 300), body: text(plan.body, 8000) };
    }
    case 'whatsapp': {
      const mode = plan.mode === 'message' ? 'message' : plan.mode === 'search' ? 'search' : 'chats';
      const target = text(plan.target, 200);
      return mode === 'message' && !target ? clarification('Who should I prepare the WhatsApp message for?') : { action: 'whatsapp', mode, target, instruction: text(plan.instruction, 2000) };
    }
    case 'calendar': return { action: 'calendar', mode: plan.mode === 'draft' ? 'draft' : 'upcoming' };
    case 'whodb': return { action: 'whodb', question: text(plan.question, 2000) };
    case 'kubernetes': return { action: 'kubernetes', query: text(plan.query, 2000) || request };
    case 'system': return systemActions.includes(text(plan.name)) ? { action: 'system', name: text(plan.name) } : clarification('Which macOS action would you like?');
    default: return clarification('What would you like me to open, find, or prepare?');
  }
}

export function assistantRoutingPrompt(now = new Date()): string {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `You are Habibi, a local-first macOS assistant. Choose the capability that best fulfills the user's CURRENT request. Return ONE JSON action and its arguments, without Markdown. Context helps resolve follow-ups, but never carry an old task into an unrelated new request. Today is ${today} in the user's local timezone.
Capabilities and argument shapes:
- {"action":"open_url","url":"https://..."}: open an explicit URL or the official homepage of a named website. For "open Mozilla website", use its official homepage. You may resolve a confidently known brand to its canonical HTTPS homepage. Preserve literal user URLs exactly, including paths and query parameters; never replace one with another destination. If unsure of a named website, use browser_search for its official website or ask a focused question. Never search LOCAL FILES for a website.
- {"action":"open_folder","folder":"..."}: open one of ${Object.keys(NAMED_FOLDERS).join(', ')}. "open downloads" opens the Downloads folder; it is not a filename search. Never return arbitrary paths or shell commands.
- {"action":"open_app","app":"application name"}: launch an installed application. Habibi resolves it locally.
- {"action":"local_files"}: search for an actual local file/document/image, filename, or a file-request follow-up. Use only when the user wants local files. "open a company's website" is NOT local_files.
- {"action":"browser_search","provider":"airbnb"|"google","query":"destination or search query","checkin":"YYYY-MM-DD or omit","checkout":"YYYY-MM-DD or omit","adults":number or omit}: open real search results. Use Airbnb when requested; preserve destination, dates and guest count. Relative dates must be resolved from today. Do not claim to have searched, found listings, booked, or paid. Ordinary explanations do not need browser search.
- {"action":"mail","mode":"inbox"|"search"|"compose","query":"mail filter if searching","to":"recipient email if supplied","subject":"draft subject","body":"draft message"}: open connected Mail, search sender/subject/content metadata, or prepare an editable email. Never send. Missing recipient details stay blank for the user to fill in. Do not invent addresses.
- {"action":"whatsapp","mode":"chats"|"search"|"message","target":"contact name or chat query","instruction":"message drafting instructions"}: open linked WhatsApp, find a chat, or prepare a message for review. Contacts are resolved locally; never invent contact details or send messages.
- {"action":"calendar","mode":"upcoming"|"draft"}: show upcoming events or prepare an editable event from the user's request. Never create an event without the existing approval step.
- {"action":"whodb","question":"question about the user's WhoDB data, or empty for opening"}: open WhoDB and run read-only questions. General questions ABOUT the product WhoDB are chat, not data queries.
- {"action":"kubernetes","query":"the investigation request"}: open the existing Kubernetes investigation capability.
- {"action":"system","name":"${systemActions.join('|')}"}: open the existing macOS action UI. Destructive actions retain their confirmation; this action never grants approval.
- {"action":"provider_chat","provider":"chatgpt"|"claude"|"gemini","query":"request"}: only when explicitly asked to use another assistant in the browser.
- {"action":"clarify","question":"one concise question"}: only for a genuinely missing detail needed to choose a destination or capability.
- {"action":"chat"}: answer ordinary questions, explanations, writing, or conversation in Habibi.
You are planning, not executing. Never say an action already happened. Never invent file contents, inbox results, contacts, web results, permissions, bookings, or authentication. No capability accepts arbitrary code. Do not route websites, Mail, WhatsApp, or travel requests to local files.`;
}

interface CompletionResult { ok: boolean; text?: string; error?: string; needsConfiguration?: boolean }
type Complete = (request: { messages: { role: 'user'; text: string }[]; systemPrompt: string }) => Promise<CompletionResult>;

export function createAssistantRouter({ complete }: { complete: Complete }) {
  return {
    async route({ text: requestText, context = '' }: { text: string; context?: string }): Promise<AssistantRoute> {
      const request = text(requestText, 4000);
      if (!request) return { ok: true, action: 'chat' };
      const result = await complete({ messages: [{ role: 'user', text: `Prior user request: ${text(context, 2000)}\nCurrent request: ${request}` }], systemPrompt: assistantRoutingPrompt() });
      if (!result.ok) {
        const safeError = text(result.error, 300);
        const error = /^OpenAI (?:rejected|denied|has no available quota|model is unavailable|could not complete)/.test(safeError) && !/sk-|\/Users\/|Bearer/i.test(safeError)
          ? safeError : 'The configured model could not plan this action. Check Model settings and try again.';
        return { ok: false, action: 'chat', needsConfiguration: result.needsConfiguration, error };
      }
      try { return { ok: true, ...normalizeAssistantPlan(JSON.parse(String(result.text).replace(/^```(?:json)?\s*|\s*```$/g, '').trim()), request) }; }
      catch { return { ok: false, action: 'chat', error: 'Habibi could not interpret the model’s action. Please try again.' }; }
    },
  };
}
