import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';
import { setHtml } from '../../core/safe-dom.js';
import { track } from '../../core/analytics.js';

export function createHomeController({
  input,
  defaultView,
  resultsView,
  count,
  notify,
  calendar,
  kubernetes,
  agentSessions,
  settings,
  mail,
  whatsappSetup,
  modelSetup,
  demoMode,
  homeLayoutDefaults,
  onboardingDismissedKey,
  onboardingShortcutKey,
  onboardingPreviewKey,
  onOpenHome,
}) {
  function homeLayout() {
    try {
      return {
        ...homeLayoutDefaults,
        ...JSON.parse(localStorage.getItem('habibi.home-layout') || '{}'),
      };
    } catch (_) {
      return { ...homeLayoutDefaults };
    }
  }
  function applyHomeLayout() {
    const layout = homeLayout();
    const sections = {
      header: [document.querySelector('.topbar')],
      briefing: [document.querySelector('#proactive-briefing')],
      calendar: [
        document.querySelector('.agenda-home-header'),
        document.querySelector('#agenda-glance'),
      ],
      mail: [document.querySelector('#proactive-mail')],
      suggestions: [document.querySelector('#quick-samples')],
      footer: [document.querySelector('footer')],
    };
    Object.entries(sections).forEach(([id, nodes]) =>
      nodes
        .filter(Boolean)
        .forEach((node) => node.classList.toggle('home-section-hidden', !layout[id])),
    );
    const hasContext = calendar.hasContext();
    defaultView.classList.toggle('home-focus-only', layout.focusOnly && !hasContext);
    window.webkit?.messageHandlers?.habibiNative?.postMessage({
      type: 'dragZones',
      headerVisible: layout.header,
    });
  }
  function saveHomeLayout(id, visible) {
    const next = homeLayout();
    next[id] = visible;
    localStorage.setItem('habibi.home-layout', JSON.stringify(next));
    applyHomeLayout();
  }
  function showDefault() {
    kubernetes.stop();
    agentSessions.close();
    settings?.close();
    window.__habibiAttachPastedFiles = null;
    onOpenHome();
    input.placeholder = 'Search anything, or ask Habibi…';
    input.value = '';
    defaultView.classList.remove('hidden');
    resultsView.classList.add('hidden');
    count.textContent = '6 skills available';
    applyHomeLayout();
    loadGettingStarted();
    calendar.loadHome();
    renderQuickSamples();
    track('habibi.launcher.opened', { surface: 'home', app_type: 'native', app_version: '0.1.0' });
  }
  function reopenGettingStarted() {
    localStorage.removeItem(onboardingDismissedKey);
    localStorage.setItem(onboardingPreviewKey, 'true');
    showDefault();
  }
  async function loadGettingStarted() {
    const target = document.querySelector('#getting-started');
    if (!target) return;
    // The README renderer deliberately uses no real connection state.
    if (demoMode) {
      target.classList.add('hidden');
      setHtml(target, '');
      return;
    }
    const preview = localStorage.getItem(onboardingPreviewKey) === 'true';
    if (localStorage.getItem(onboardingDismissedKey) === 'done' && !preview) {
      target.classList.add('hidden');
      setHtml(target, '');
      return;
    }
    target.classList.remove('hidden');
    setHtml(
      target,
      '<div class="getting-started-loading"><span class="mini-spinner"></span> Checking your setup…</div>',
    );
    // Resolve every setup check before replacing the spinner to avoid flickering state.
    const [launchAtLogin, mail, whatsapp, llm] = await Promise.all([
      new Promise((resolve) => {
        const bridge = window.webkit?.messageHandlers?.habibiNative;
        if (!bridge) return resolve(false);
        const timeout = setTimeout(() => resolve(false), 1_500);
        window.__habibiLaunchAtLoginState = (result) => {
          clearTimeout(timeout);
          resolve(Boolean(result?.enabled));
        };
        bridge.postMessage({ type: 'launchAtLoginState' });
      }),
      fetch('/api/mail/status')
        .then((response) => response.json())
        .catch(() => ({ accounts: [] })),
      fetch('/api/openwa/status')
        .then((response) => response.json())
        .catch(() => ({ session: null })),
      fetch('/api/llm/status')
        .then((response) => response.json())
        .catch(() => ({ configured: false })),
    ]);
    if (
      target !== document.querySelector('#getting-started') ||
      localStorage.getItem(onboardingDismissedKey) === 'done'
    )
      return;
    const steps = [
      {
        id: 'shortcut',
        icon: 'keyboard',
        title: 'Choose your shortcut',
        detail: 'Open Habibi from anywhere',
        done: Boolean(localStorage.getItem(onboardingShortcutKey)),
        action: 'shortcut',
        cta: 'Set shortcut',
      },
      {
        id: 'login',
        icon: 'power',
        title: 'Start at login',
        detail: 'Keep Habibi ready in your menu bar',
        done: launchAtLogin,
        action: 'login',
        cta: 'Enable',
      },
      {
        id: 'model',
        icon: 'sparkles',
        title: 'Connect a model',
        detail: 'Use local models or your own provider',
        done: Boolean(llm.configured),
        action: 'model',
        cta: 'Connect model',
      },
      {
        id: 'mail',
        icon: 'mail',
        title: 'Connect your mail',
        detail: 'Search and reply from one place',
        done: (mail.accounts || []).some((account) => account.connected),
        action: 'mail',
        cta: 'Connect mail',
      },
      {
        id: 'whatsapp',
        icon: 'message-circle-more',
        title: 'Connect WhatsApp',
        detail: 'Find chats and draft messages locally',
        done: whatsapp.session?.status === 'ready',
        action: 'whatsapp',
        cta: 'Connect WhatsApp',
      },
    ];
    if (steps.every((step) => step.done) && !preview) {
      localStorage.setItem(onboardingDismissedKey, 'done');
      target.classList.add('hidden');
      setHtml(target, '');
      return;
    }
    setHtml(
      target,
      `<div class="getting-started-heading"><span><span class="briefing-heading">GETTING STARTED</span><b>Make Habibi yours</b><small>Set up only what you want. You can come back to this any time.</small></span><button type="button" class="getting-started-dismiss" id="dismiss-getting-started">Not now</button></div><div class="getting-started-steps">${steps.map((step) => `<button type="button" class="getting-started-step ${step.done ? 'complete' : ''}" data-onboarding-action="${step.action}"><span class="getting-started-icon">${icon(step.done ? 'check' : step.icon)}</span><span><b>${escapeHtml(step.title)}</b><small>${escapeHtml(step.done ? 'Ready' : step.detail)}</small></span><em>${step.done ? 'DONE' : escapeHtml(step.cta)}</em><i>${icon('chevron-right')}</i></button>`).join('')}</div>`,
    );
    document.querySelector('#dismiss-getting-started')?.addEventListener('click', () => {
      localStorage.setItem(onboardingDismissedKey, 'done');
      localStorage.removeItem(onboardingPreviewKey);
      target.classList.add('hidden');
    });
    target.querySelectorAll('[data-onboarding-action]').forEach((button) =>
      button.addEventListener('click', () => {
        const action = button.dataset.onboardingAction;
        if (action === 'shortcut') return settings.show({ focus: 'shortcut' });
        if (action === 'login') {
          const bridge = window.webkit?.messageHandlers?.habibiNative;
          if (!bridge) return;
          window.__habibiLaunchAtLoginState = (result) => {
            notify(result?.message || 'Updated start at login.');
            loadGettingStarted();
          };
          bridge.postMessage({ type: 'launchAtLogin', enabled: true });
          return;
        }
        if (action === 'mail') return mail.showClient();
        if (action === 'whatsapp') return whatsappSetup.show();
        if (action === 'model') return modelSetup.show({ afterConfigured: showDefault });
      }),
    );
    refreshIcons();
  }
  function dismissLauncher() {
    const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
    if (nativeBridge) nativeBridge.postMessage('dismiss');
    else {
      showDefault();
      input.blur();
    }
  }
  function markActivity() {
    localStorage.setItem('habibi.lastActivity', String(Date.now()));
    renderQuickSamples();
  }
  function renderQuickSamples() {
    const samples = document.querySelector('#quick-samples');
    if (!samples) return;
    const lastActivity = Number(localStorage.getItem('habibi.lastActivity') || 0);
    const shouldShow = !lastActivity || Date.now() - lastActivity > 36 * 60 * 60 * 1000;
    samples.classList.toggle('hidden', !shouldShow);
  }

  return {
    applyLayout: applyHomeLayout,
    dismiss: dismissLauncher,
    layout: homeLayout,
    markActivity,
    renderQuickSamples,
    reopenGettingStarted,
    saveLayout: saveHomeLayout,
    show: showDefault,
  };
}
