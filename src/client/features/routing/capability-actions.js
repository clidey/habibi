import { calendarDraftFromText } from '../calendar/event-intent.js';

/** A model chooses a capability; only existing, bounded application actions execute it. */
export function createCapabilityActions({ input, resultsView, platformActions, mail, whatsapp, whatsappSetup, calendar, kubernetes, openWhoDb, openBrowser, routeWhatsApp }) {
  return {
    async execute(plan, request) {
      switch (plan.action) {
        case 'open_url': case 'browser_search': case 'provider_chat': return openBrowser(plan);
        case 'open_folder': {
          const result = await platformActions.openFolder(plan.folder);
          return result?.ok ? { ok: true, message: `Opened ${plan.folder}.` } : { ok: false, error: `I could not open ${plan.folder}. Check that the folder exists.` };
        }
        case 'open_app': {
          const data = await fetch(`/api/apps?q=${encodeURIComponent(plan.app)}`).then(response => response.json());
          const apps = data.apps || [];
          const app = apps.find(item => item.name.toLowerCase() === plan.app.toLowerCase()) || (apps.length === 1 ? apps[0] : null);
          if (!app) return { ok: false, error: apps.length ? `Which application did you mean: ${apps.slice(0, 4).map(item => item.name).join(', ')}?` : `I could not find an installed application named ${plan.app}.` };
          const button = document.createElement('button');
          button.dataset.title = app.name;
          button.dataset.path = encodeURIComponent(app.path);
          const result = await platformActions.openApp(button);
          return result?.ok ? { ok: true, message: `Opened ${app.name}.` } : { ok: false, error: `I could not open ${app.name}.` };
        }
        case 'mail':
          if (plan.mode === 'compose') mail.showComposer('New email', undefined, { to: plan.to, subject: plan.subject, body: plan.body });
          else mail.showClient({ query: plan.mode === 'search' ? plan.query : '' });
          return { ok: true, navigated: true };
        case 'whatsapp': {
          if (plan.mode === 'message') routeWhatsApp({ kind: 'whatsapp', target: plan.target, instruction: plan.instruction, original: request });
          else if (plan.mode === 'search' && plan.target) {
            const status = await fetch('/api/openwa/status').then(response => response.json());
            if (status.ok && status.session?.status === 'ready') whatsapp.showChats({ query: plan.target });
            else whatsappSetup.show();
          }
          else whatsappSetup.show();
          return { ok: true, navigated: true };
        }
        case 'calendar':
          if (plan.mode === 'draft') calendar.showDraft(calendarDraftFromText(request));
          else calendar.showUpcoming();
          return { ok: true, navigated: true };
        case 'whodb':
          await openWhoDb();
          if (plan.question) {
            const field = resultsView.querySelector('#whodb-question');
            if (field) { field.value = plan.question; resultsView.querySelector('#ask-whodb')?.click(); }
          }
          return { ok: true, navigated: true };
        case 'kubernetes':
          kubernetes.show(plan.query || request);
          return { ok: true, navigated: true };
        case 'system':
          if (plan.name === 'quitApps' || plan.name === 'forceQuitApps') platformActions.showRunning(plan.name === 'quitApps' ? 'quit' : 'force');
          else await platformActions.showSystem(plan.name, plan.name === 'settings' ? 'System Settings' : plan.name);
          return { ok: true, navigated: true };
        default: return { ok: false, error: 'That capability is not available.' };
      }
    },
  };
}
