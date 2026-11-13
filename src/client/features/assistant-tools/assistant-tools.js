import { installPathMentions } from './path-mentions.js';
import { addFileTask } from './file-cards.js';
import { addDailyTask } from './daily-cards.js';
import { fileRequest } from './api.js';
const fileTask = (text) =>
  /\brenam/i.test(text)
    ? 'rename'
    : /\b(?:organiz|organis|sort|tidy)/i.test(text)
      ? 'organize'
      : /\b(?:duplicate|redundant|identical)/i.test(text)
        ? 'duplicates'
        : /\b(?:storage|disk space|large files|taking.*space|clean up|cleanup)/i.test(text)
          ? 'storage'
          : /\b(?:compress|resize|convert|smaller|shrink)/i.test(text)
            ? 'compress'
            : /\b(?:spreadsheet|expense|extract.*(?:csv|data|total)|csv)/i.test(text)
              ? 'extract'
              : /\b(?:pdf|merge|split|rotate|pages)/i.test(text)
                ? 'pdf'
                : /\b(?:find|which|version|search)/i.test(text)
                  ? 'find'
                  : 'organize';
export async function installAssistantTools({
  draft,
  messages,
  addTurn,
  notify,
  initialGrants = [],
}) {
  const mentions = await installPathMentions(draft, notify, { initialGrants });
  return {
    capture: (text) => mentions.capture(text),
    async handle(text, grants = []) {
      const wantsFiles =
        /\b(?:rename|organize|organise|compress|duplicates?|storage|disk space|merge.*pdf|split.*pdf|extract.*(?:spreadsheet|csv))\b/i.test(
          text,
        );
      if (grants.length) {
        await addFileTask({ messages, request: text, grants, task: fileTask(text), notify });
        return true;
      }
      if (wantsFiles || /@(?:"|\/|~\/)/.test(text)) {
        addTurn(
          'assistant',
          'Mention a file or folder with @ first. I’ll prepare a preview using only those selected paths.',
        );
        draft.focus();
        return true;
      }
      if (!/\b(?:timer|focus|pomodoro|remind|reminders?|clipboard|recent files)\b/i.test(text))
        return false;
      try {
        const exact = text
          .trim()
          .toLowerCase()
          .replace(/^(?:open|show|view)\s+(?:my\s+)?/, '');
        const local = /^(?:clipboard|clipboard history)$/.test(exact)
          ? { kind: 'clipboard' }
          : /^(?:recent files|recents)$/.test(exact)
            ? { kind: 'recents' }
            : /^(?:reminders|tasks)$/.test(exact)
              ? { kind: 'reminder', action: 'list' }
              : /^(?:timer|focus|focus timer|pomodoro)$/.test(exact)
                ? { kind: 'timer', action: 'show' }
                : null;
        const { plan } = local ? { plan: local } : await fileRequest('daily', { request: text });
        if (plan.kind === 'clarify') addTurn('assistant', plan.question);
        else {
          addTurn(
            'assistant',
            plan.kind === 'reminder' && plan.action === 'create'
              ? 'Review this reminder before saving it to your list.'
              : plan.kind === 'timer' && plan.action === 'start'
                ? 'Your timer is ready. Start it when you’re ready.'
                : 'Here are the controls for that request.',
          );
          await addDailyTask({ messages, plan, notify });
        }
      } catch (error) {
        addTurn('assistant', error.message);
      }
      return true;
    },
  };
}

export { installPathMentions } from './path-mentions.js';
