import { isConversationalQuery } from '../../core/query.js';
import { setHtml } from '../../core/safe-dom.js';
import { createSearchSources } from './search-sources.js';

/** Local command matching plus debounced Spotlight searching. */
export function createSearchFeature({
  input,
  defaultView,
  resultsView,
  count,
  results,
  resultButton,
  refreshIcons,
}) {
  let localSearchSequence = 0;
  let localSearchTimer = null;
  let appSearchSequence = 0;

  // A file-only result set is a complete search surface in its own right.
  // Don't reserve a blank “Best matches” region above it: that creates a
  // misleading divider and makes local search feel like a fallback.
  function syncResultsLayout() {
    const bestRegion = resultsView.querySelector('.best-matches-region');
    const localSection = resultsView.querySelector('.local-files-section');
    if (!bestRegion || !localSection) return;
    const fileOnly = !bestRegion.textContent.trim();
    bestRegion.classList.toggle('hidden', fileOnly);
    localSection.classList.toggle('local-files-section--only', fileOnly);
  }

  const sources = createSearchSources({
    input,
    resultsView,
    count,
    resultButton,
    refreshIcons,
    syncResultsLayout,
    getAppSequence: () => appSearchSequence,
    getLocalSequence: () => localSearchSequence,
  });

  function renderSearch(query) {
    const q = query.toLowerCase();
    const queryWords = q.trim().split(/\s+/).filter(Boolean);
    // Launcher commands need to feel like Spotlight: `empty t` should find
    // “Empty Trash”, even before the last word has been completed. Match the
    // words in order so a partial command never falls through to chat-first.
    const commandMatches = queryWords.length
      ? results.filter((item) => {
          const titleWords = String(item.title || '')
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
          return queryWords.every((word, index) => titleWords[index]?.startsWith(word));
        })
      : [];
    const folderQuery = q
      .replace(/^(?:open|show|go to|find)\s+/, '')
      .replace(/\s+folder$/, '')
      .trim();
    const folders = {
      downloads: { title: 'Downloads', meta: 'Open your Downloads folder', folder: 'Downloads' },
      documents: { title: 'Documents', meta: 'Open your Documents folder', folder: 'Documents' },
      desktop: { title: 'Desktop', meta: 'Open your Desktop folder', folder: 'Desktop' },
      home: { title: 'Home folder', meta: 'Open your home folder', folder: 'Home' },
    };
    const folderKey =
      folderQuery.length >= 3 && Object.keys(folders).find((name) => name.startsWith(folderQuery));
    const folderIntent = folderKey
      ? { icon: 'files', glyph: '⌁', tag: 'FOLDER', type: 'folder', ...folders[folderKey] }
      : null;
    const wordCount = query.trim().split(/\s+/).filter(Boolean).length;
    const isFileTypeSearch = ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'md'].includes(q);
    const naturalMessage = /^message\s+.+\s+(?:on\s+)?whatsapp(?:\s|$)/i.test(query);
    const conversational = isConversationalQuery(query);
    const preferenceQuery = /^(?:habibi\s+)?(?:settings?|preferences?|prefs?)/.test(q);
    const kubernetesIntent =
      /\b(?:k8s|kubernetes|kubectl|pods?|deployments?|statefulsets?|daemonsets?|replicasets?|cronjobs?|namespaces?|contexts?|cluster|container|ingress(?:es)?|services?|events?|logs?|crashloop|oomkilled)\b/.test(
        q,
      ) ||
      (/\bprod(?:uction)?\b/.test(q) && /\b(?:show|check|find|why|what|status|health)\b/.test(q));
    const specific = preferenceQuery
      ? results.filter((x) => x.type === 'preferences')
      : commandMatches.length
        ? commandMatches
        : isFileTypeSearch
          ? []
          : kubernetesIntent
            ? [
                {
                  icon: 'agents',
                  title: 'Ask Habibi about this',
                  meta: 'Habibi will route this Kubernetes investigation to the right local plugin',
                  tag: 'HABIBI',
                  type: 'assistant',
                },
              ]
            : naturalMessage
              ? [
                  {
                    icon: 'agents',
                    title: 'Ask Habibi to prepare this WhatsApp message',
                    meta: 'AI · resolves the recipient locally, then shows the real chat before sending',
                    tag: 'HABIBI',
                    type: 'assistant',
                  },
                ]
              : conversational
                ? [
                    {
                      icon: 'agents',
                      title: 'Ask Habibi about this',
                      meta: 'Chat-first · interprets your request and chooses the right local capability',
                      tag: 'HABIBI',
                      type: 'assistant',
                    },
                  ]
                : /^(?:w|wh|wha|what|whats|whatsapp)/.test(q)
                  ? results.filter((x) => x.type === 'whatsapp')
                  : q.includes('message')
                    ? results.filter((x) => x.type === 'whatsapp')
                    : q.includes('event') || q.includes('calendar')
                      ? results.filter((x) => x.type === 'event' || x.type === 'agenda')
                      : q.includes('codex')
                        ? results.filter((x) => x.type === 'codex')
                        : q.includes('claude')
                          ? results.filter((x) => x.type === 'claude')
                          : q.includes('agent')
                            ? results.filter((x) => ['agent', 'codex', 'claude'].includes(x.type))
                            : q.includes('mail') || q.includes('email')
                              ? results.filter((x) => x.type === 'email')
                              : q.includes('file') || q.includes('folder') || q.includes('document')
                                ? results.filter((x) => x.type === 'file')
                                : results.filter(
                                    (x) => !q || `${x.title} ${x.meta}`.toLowerCase().includes(q),
                                  );
    // Never pad an active search with unrelated apps. The empty launcher can
    // offer capability suggestions; a user query must earn every result.
    const list = folderIntent
      ? [folderIntent]
      : specific.length
        ? specific
        : isFileTypeSearch
          ? []
          : query
            ? results.filter((item) =>
                String(item.title || '')
                  .toLowerCase()
                  .includes(q),
              )
            : results.slice(0, 3);
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    const bestMarkup = list.length
      ? `<div class="result-header"><b>${query ? 'Best matches' : 'Recent and suggested'}</b><span>${list.length} result${list.length === 1 ? '' : 's'}</span></div><div class="result-list">${list.map(resultButton).join('')}</div>`
      : '';
    const bestKey = list.map((item) => `${item.type}:${item.title}`).join('|');
    let bestRegion = resultsView.querySelector('.best-matches-region');
    let localSection = resultsView.querySelector('.local-files-section');
    if (!bestRegion || !localSection) {
      setHtml(
        resultsView,
        '<section class="best-matches-region"></section><section class="local-files-section" aria-live="polite"><div class="local-files-slot"></div></section>',
      );
      bestRegion = resultsView.querySelector('.best-matches-region');
      localSection = resultsView.querySelector('.local-files-section');
    }
    if (bestRegion.dataset.key !== bestKey) {
      setHtml(bestRegion, bestMarkup);
      bestRegion.dataset.key = bestKey;
      refreshIcons();
    }
    syncResultsLayout();
    const appSequence = ++appSearchSequence;
    if (query.trim().length >= 2) sources.searchApplications(query, list, appSequence);
    const localSlot = localSection.querySelector('.local-files-slot');
    const shouldSearchFiles = q.length >= 2 && !(conversational && wordCount > 7);
    clearTimeout(localSearchTimer);
    localSection.setAttribute('aria-busy', String(shouldSearchFiles));
    if (!shouldSearchFiles) {
      localSearchSequence += 1;
      setHtml(localSlot, '');
    }
    count.textContent = `${list.length} results`;
    if (shouldSearchFiles) {
      const sequence = ++localSearchSequence;
      localSearchTimer = setTimeout(() => {
        if (sequence !== localSearchSequence || input.value !== query) return;
        if (!localSlot.innerHTML.trim())
          setHtml(
            localSlot,
            '<div class="local-files-loading"><span class="mini-spinner"></span>Finding local files…</div>',
          );
        // Always reserve at least one index for Best matches: async app
        // discovery may replace the initial static list while file search is
        // in flight, and file rows must never steal the selected state.
        sources.searchLocalFiles(query, Math.max(list.length, 1), sequence);
      }, 220);
    }
  }

  return { renderSearch, searchLocalFiles: sources.searchLocalFiles };
}
