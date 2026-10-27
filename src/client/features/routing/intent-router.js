import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, spinner } from '../../core/view-helpers.js';
import { calendarDraftFromText } from '../calendar/event-intent.js';
import { browserCommand } from '../../../core/browser-url.js';
import { createCapabilityActions } from './capability-actions.js';

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
  whatsappSetup,
  platformActions,
  openWhoDb,
  onChat,
  onHome,
}) {
  function showAgenticMessage(command) {
    return onChat(command);
  }
  function parseAppIntent(command = '') {
    const url = browserCommand(command);
    if (url) return { kind: 'browser', url };
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
    if (intent.kind === 'browser') return openDirectUrl(intent.url);
    if (intent.kind === 'kubernetes') return kubernetes.show(intent.source || '');
    if (intent.kind === 'calendar')
      return calendar.showDraft(calendarDraftFromText(intent.source || ''));
    if (intent.kind === 'email') return mail.showClient({ compose: true });
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = 'WhatsApp · finding chat';
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><b>WhatsApp</b><span class="verified">● local resolution</span></div><div class="loading-state">${spinner()} Finding ${escapeHtml(intent.target)}…</div>`,
    );
    fetch('/api/whatsapp/chats')
      .then((response) => response.json())
      .then((data) => {
        if (!data.ok) return whatsappSetup.show();
        const chats = (data.chats || []).filter((chat) => chat.kind !== 'status' && !chat.archived);
        const resolved = whatsapp.resolveRecipient(chats, intent.target);
        if (resolved.chat) {
          whatsapp.showChat(resolved.chat);
          if (resolved.instruction || intent.instruction)
            whatsapp.draftMessage(resolved.chat, resolved.instruction || intent.instruction, intent.original);
          return;
        }
        whatsapp.showChats({ query: intent.target });
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
    return openDirectUrl(intent.url, providerLabel);
  }

  async function openDirectUrl(url, label) {
    try {
      const response = await fetch('/api/approvals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'browser.open', payload: { url } }),
      }).then(response => response.json());
      if (!response.ok || !response.approval?.token) throw new Error('The website could not be opened. Try again.');
      const result = await fetch('/api/browser/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, approvalToken: response.approval.token }),
      }).then(response => response.json());
      if (!result.ok) throw new Error(result.error || 'The website could not be opened. Try again.');
      notify(`Opened ${new URL(url).hostname}`);
      return { ok: true, message: `Opened ${label || new URL(url).hostname} in your browser.` };
    } catch (error) {
      const message = error.message || 'The website could not be opened. Try again.';
      notify(message);
      return { ok: false, error: message };
    }
  }
  function openAgentBrowserSearch(route) {
    if (route.action === 'open_url') return openDirectUrl(route.url);
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

  const capabilities = createCapabilityActions({ input, resultsView, platformActions, mail, whatsapp, whatsappSetup, calendar, kubernetes, openWhoDb, openBrowser: openAgentBrowserSearch, routeWhatsApp: routeAppIntent });
  return {
    execute: capabilities.execute,
    openBrowser: openAgentBrowserSearch,
    parse: parseAppIntent,
    route: routeAppIntent,
    showAgentic: showAgenticMessage,
  };
}
