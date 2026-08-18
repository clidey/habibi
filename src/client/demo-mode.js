import { refreshIcons } from './core/view-helpers.js';
import { setHtml } from './core/safe-dom.js';

export function initializeDemoMode({ demoMode, demoScreen, homeLayoutDefaults, input, defaultView, resultsView, count, resultButton, settings, calendar, renderQuickSamples }) {
  if (!demoMode) {
    calendar.loadHome();
    renderQuickSamples();
    return;
  }
  localStorage.setItem('habibi.getting-started.dismissed.v1', 'done');
  localStorage.setItem('habibi.home-layout', JSON.stringify({ ...homeLayoutDefaults, suggestions:false, assistant:false }));
  if (demoScreen === 'search') {
    input.value = 'project brief';
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = '3 results';
    const files = [
      { icon:'file-text', title:'Project Aurora brief.pdf', meta:'Documents · ~/Documents/Strategy', tag:'FILE', type:'file', path:'/demo/Documents/Project Aurora brief.pdf' },
      { icon:'files', title:'Aurora launch notes.md', meta:'Documents · ~/Documents/Strategy', tag:'FILE', type:'file', path:'/demo/Documents/Aurora launch notes.md' },
      { icon:'files', title:'Project Aurora assets', meta:'Downloads · ~/Downloads', tag:'FOLDER', type:'file', path:'/demo/Downloads/Project Aurora assets' },
    ];
    setHtml(resultsView, `<section class="best-matches-region"><div class="result-header"><b>Best matches</b><span>1 result</span></div><div class="result-list">${resultButton(files[0], 0)}</div></section><section class="local-files-section"><div class="inline-section"><div class="result-header"><b>Local files</b><span>Spotlight index · 2 matches</span></div><div class="result-list">${files.slice(1).map((item, index) => resultButton(item, index + 1)).join('')}</div></div></section>`);
  } else if (demoScreen === 'preferences') settings.show();
  else calendar.loadHome();
  refreshIcons();
}
