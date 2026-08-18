import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml } from '../../core/view-helpers.js';
import { calendarDraftFromText } from '../calendar/event-intent.js';

/** Routes natural-language intents between local capabilities and approved browser destinations. */
export function createIntentRouter({
  input,
  defaultView,
  resultsView,
  count,
  notify,
  kubernetes,
  calendar,
  mail,
  whatsapp,
  onChat,
  onHome,
}) {
  async function showAgenticMessage(command) {
    const match = command.match(/^message\s+(.+?)(?:\s+(?:on\s+)?whatsapp)?\s*[—-]\s*(.+)$/i);
    if (!match) {
      const appIntent = parseAppIntent(command);
      if (appIntent) return routeAppIntent(appIntent);
      // Do not let the launcher bypass Habibi's capability loop. The ephemeral
      // agent first checks local tools (files, mail, calendar, WhatsApp) and
      // only then delegates a genuinely live-web request to the browser router.
      return onChat(command);
    }
    const [, recipient, draft] = match;
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><b>Habibi</b><span class="verified">● local interpretation</span></div><div class="loading-state"><span class="spinner"></span> Resolving ${escapeHtml(recipient.trim())} in your WhatsApp chats…</div>`,
    );
    fetch('/api/whatsapp/chats')
      .then((response) => response.json())
      .then((data) => {
        const needle = recipient.trim().toLowerCase();
        const chat =
          (data.chats || []).find((item) => (item.name || '').toLowerCase() === needle) ||
          (data.chats || []).find((item) => (item.name || '').toLowerCase().includes(needle));
        if (!chat) return notify(`No WhatsApp chat found for ${recipient.trim()}`);
        whatsapp.showChat(chat, draft.trim());
      })
      .catch(() => notify('Could not read your WhatsApp chats'));
  }
  function parseAppIntent(command = '') {
    const message = command.trim().replace(/[?.!]+$/, '');
    const whatsapp = message.match(
      /^(?:can\s+you\w*\s+)?(?:ping|message|text|send a message to|reply to)\s+(.+?)(?:\s+(?:on\s+)?whatsapp)?$/i,
    );
    if (whatsapp) return { kind: 'whatsapp', target: whatsapp[1].trim(), original: command.trim() };
    if (
      /\b(?:k8s|kubernetes|kubectl|pods?|deployments?|statefulsets?|daemonsets?|replicasets?|cronjobs?|namespaces?|contexts?|cluster|container|ingress(?:es)?|services?|events?|logs?|crashloop|oomkilled)\b/i.test(
        message,
      ) ||
      (/\bprod(?:uction)?\b/i.test(message) &&
        /\b(?:show|check|find|why|what|status|health)\b/i.test(message))
    )
      return { kind: 'kubernetes', source: command };
    if (
      /\b(?:create|schedule|book|add)\b.*\b(?:calendar|meeting|event)\b|\b(?:calendar|meeting|event)\b.*\b(?:create|schedule|book|add)\b/i.test(
        message,
      ) ||
      (/\b(?:meeting|meet|appointment|call|lunch|dinner)\b/i.test(message) &&
        /\b(?:next|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s*(?:am|pm)?\s*(?:-|to))\b/i.test(
          message,
        ))
    )
      return { kind: 'calendar', source: command };
    if (
      /\b(?:email|gmail|mail)\b/i.test(message) &&
      /\b(?:write|draft|reply|send)\b/i.test(message)
    )
      return { kind: 'email' };
    return null;
  }
  function routeAppIntent(intent) {
    if (intent.kind === 'kubernetes') return kubernetes.show(intent.source || '');
    if (intent.kind === 'calendar')
      return calendar.showDraft(calendarDraftFromText(intent.source || ''));
    if (intent.kind === 'email') return mail.showClient({ compose: true });
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = 'WhatsApp · finding chat';
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><b>WhatsApp</b><span class="verified">● local resolution</span></div><div class="loading-state"><span class="spinner"></span> Finding ${escapeHtml(intent.target)}…</div>`,
    );
    fetch('/api/whatsapp/chats')
      .then((response) => response.json())
      .then((data) => {
        const chats = (data.chats || []).filter((chat) => chat.kind !== 'status' && !chat.archived);
        const resolved = whatsapp.resolveRecipient(chats, intent.target);
        if (resolved.chat) {
          whatsapp.showChat(resolved.chat);
          if (resolved.instruction)
            whatsapp.draftMessage(resolved.chat, resolved.instruction, intent.original);
          return;
        }
        whatsapp.showChats();
        setTimeout(() => {
          input.value = intent.target;
          whatsapp.filter(intent.target);
          input.focus();
        }, 120);
      })
      .catch(() => notify('Could not read your WhatsApp chats'));
  }
  function openWebSearch(intent) {
    const providerLabel =
      intent.provider === 'airbnb'
        ? 'Airbnb'
        : intent.provider === 'ChatGPT'
          ? 'ChatGPT'
          : intent.provider === 'Claude'
            ? 'Claude'
            : intent.provider === 'Gemini'
              ? 'Gemini'
              : 'Google';
    // Resetting to home before the request settles disconnects the failure
    // toast from the search that triggered it — wait for the real outcome, and
    // say why it failed rather than reusing one fixed string for every cause.
    return fetch('/api/open-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: intent.url }),
    })
      .then((response) => response.json())
      .then((result) => {
        if (!result.ok) throw new Error('That destination is not allowed to open automatically.');
        notify(`Opened ${providerLabel}`);
      })
      .catch((error) => notify(error.message || 'Could not reach Habibi to open that link.'))
      .finally(() => onHome());
  }
  function openAgentBrowserSearch(route) {
    if (route.action === 'provider_chat') {
      const provider =
        route.provider === 'claude' ? 'claude' : route.provider === 'gemini' ? 'gemini' : 'chatgpt';
      const url =
        provider === 'claude'
          ? `https://claude.ai/new?q=${encodeURIComponent(route.query)}`
          : provider === 'gemini'
            ? `https://gemini.google.com/app?q=${encodeURIComponent(route.query)}`
            : `https://chatgpt.com/?q=${encodeURIComponent(route.query)}`;
      return openWebSearch({
        provider: provider === 'chatgpt' ? 'ChatGPT' : provider === 'claude' ? 'Claude' : 'Gemini',
        url,
      });
    }
    const params = new URLSearchParams({ query: route.query });
    if (route.checkin) params.set('checkin', route.checkin);
    if (route.checkout) params.set('checkout', route.checkout);
    if (route.adults) params.set('adults', String(route.adults));
    const url =
      route.provider === 'airbnb'
        ? `https://www.airbnb.co.uk/s/homes?${params.toString()}`
        : `https://www.google.com/search?q=${encodeURIComponent(route.query)}`;
    return openWebSearch({ provider: route.provider, url });
  }

  return {
    openBrowser: openAgentBrowserSearch,
    parse: parseAppIntent,
    route: routeAppIntent,
    showAgentic: showAgenticMessage,
  };
}
