import { analyticsEnabled, setAnalyticsEnabled, track } from '../../core/analytics.js';
import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';
import { llmProviders } from '../llm/provider-catalog.js';
import { themeCatalog } from './theme-catalog.js';
import { createShortcutCapture } from './shortcut-capture.js';

/** Owns appearance, home layout, integrations, analytics, shortcut, and startup preferences. */
export function createSettingsFeature({
  input,
  defaultView,
  resultsView,
  count,
  notify,
  homeLayout,
  saveHomeLayout,
  modelSetup,
  whatsappSetup,
  mail,
  calendar,
  onHome,
  onOpen,
  onRestartOnboarding,
}) {
  function applyTheme(theme = localStorage.getItem('habibi.theme') || 'deep-ocean') {
    const next = theme === 'blue' ? 'deep-ocean' : theme;
    document.body.dataset.theme = next;
    localStorage.setItem('habibi.theme', next);
  }
  function applyColorMode(mode = localStorage.getItem('habibi.color-mode') || 'dark') {
    const next = mode === 'light' ? 'light' : 'dark';
    document.body.dataset.colorMode = next;
    localStorage.setItem('habibi.color-mode', next);
  }
  const shortcutCapture = createShortcutCapture();
  function showSettings({ focus } = {}) {
    track('habibi.settings.opened', {
      surface: 'settings',
      app_type: 'native',
      app_version: '0.1.0',
    });
    shortcutCapture.close();
    onOpen();
    defaultView.classList.add('hidden');
    resultsView.classList.remove('hidden');
    count.textContent = 'Settings';
    const native = Boolean(window.webkit?.messageHandlers?.habibiNative);
    const theme = document.body.dataset.theme || 'deep-ocean';
    const colorMode = document.body.dataset.colorMode || 'dark';
    const currentShortcut = document.body.dataset.nativeShortcutLabel || '⌥ Space';
    setHtml(
      resultsView,
      `<div class="result-header conversation-mode"><button class="back-button" id="back-settings">${icon('arrow-left')} Habibi</button><span class="verified">● local preferences</span></div><section class="provider-setup settings-view"><div class="chat-title"><span class="icon agents">${icon('settings-2')}</span><span><b>Settings</b><small>Everything below stays on this Mac.</small></span></div><div class="settings-section"><div class="appearance-heading"><span class="briefing-heading">APPEARANCE</span><div class="mode-toggle" role="group" aria-label="Color mode"><button class="${colorMode === 'dark' ? 'selected' : ''}" data-color-mode="dark">${icon('moon')} Dark</button><button class="${colorMode === 'light' ? 'selected' : ''}" data-color-mode="light">${icon('sun')} Light</button></div></div><div class="theme-gallery">${themeCatalog.map((item) => `<button class="theme-card ${theme === item.id ? 'selected' : ''}" data-theme-choice="${item.id}" aria-label="Use ${item.name}"><span class="theme-thumb theme-${item.id}" style="--theme-ink:${item.swatches[2]};--theme-surface:${item.swatches[1]};--theme-base:${item.swatches[0]}"><i></i><b></b><em></em></span><span><b>${item.name}</b><small>${item.description}</small></span>${theme === item.id ? `<i class="theme-check">${icon('check')}</i>` : ''}</button>`).join('')}</div></div><div class="settings-section"><span class="briefing-heading">LAUNCHER SHORTCUT</span><div class="shortcut-recorder"><span class="shortcut-current">Current: <kbd id="shortcut-current">${escapeHtml(currentShortcut)}</kbd></span><button class="shortcut-listen" id="shortcut-listen"><span>${icon('keyboard')}</span><b>Click, then press a shortcut</b><small id="shortcut-listen-copy">We’ll check whether macOS can use it.</small></button><div class="shortcut-candidate hidden" id="shortcut-candidate"><span><b id="shortcut-candidate-label">—</b><small id="shortcut-candidate-status"></small></span><button class="primary" id="shortcut-save" disabled>Save shortcut</button></div></div>${native ? '' : '<small class="settings-note">Open Habibi.app to check and save a global shortcut.</small>'}</div></section>`,
    );
    const settingsLogo = document.createElement('img');
    settingsLogo.className = 'identity-logo';
    settingsLogo.src = '/assets/logo.png';
    settingsLogo.alt = 'Habibi';
    resultsView.querySelector('.chat-title .icon')?.replaceWith(settingsLogo);
    const layout = homeLayout();
    const layoutSection = document.createElement('section');
    layoutSection.className = 'settings-section home-layout-settings';
    setHtml(
      layoutSection,
      `<div class="appearance-heading"><span class="briefing-heading">HOME LAYOUT</span><small>Search always stays visible.</small></div><div class="home-layout-controls">${[
        ['header', 'Top bar', 'Brand and privacy status', 'panel-top'],
        ['briefing', 'Briefing', 'Your proactive summary', 'sparkles'],
        ['calendar', 'Calendar', 'Up next and events', 'calendar-days'],
        ['mail', 'Recent mail', 'New mail on Home', 'mail'],
        ['suggestions', 'Suggestions', 'Quick example prompts', 'lightbulb'],
        ['footer', 'Keyboard footer', 'Navigation hints and count', 'keyboard'],
        [
          'focusOnly',
          'Minimal when clear',
          'Show Home only when real context arrives',
          'panel-top-close',
        ],
      ]
        .map(
          ([id, title, detail, iconName]) =>
            `<label class="home-layout-control"><span class="home-layout-icon">${icon(iconName)}</span><span><b>${title}</b><small>${detail}</small></span><input type="checkbox" data-home-layout="${id}" ${layout[id] ? 'checked' : ''} aria-label="Show ${title}" /></label>`,
        )
        .join('')}</div>`,
    );
    const settingsSections = [...resultsView.querySelectorAll('.settings-section')];
    const integrationsSection = document.createElement('section');
    integrationsSection.className = 'settings-section integrations-settings';
    setHtml(
      integrationsSection,
      `<div class="appearance-heading"><span class="briefing-heading">CONNECTED SERVICES</span><small>Manage local capabilities and accounts.</small></div><div class="integration-settings-list"><button class="integration-setting" type="button" data-settings-service="model"><span class="home-layout-icon">${icon('sparkles')}</span><span><b>AI model</b><small id="settings-model-status">Checking configured model…</small></span><i>${icon('chevron-right')}</i></button><button class="integration-setting" type="button" data-settings-service="whatsapp"><span class="home-layout-icon whatsapp">${icon('message-circle-more')}</span><span><b>WhatsApp</b><small>Open chats or manage the local session.</small></span><i>${icon('chevron-right')}</i></button><button class="integration-setting" type="button" data-settings-service="mail"><span class="home-layout-icon gmail">${icon('mail')}</span><span><b>Mail accounts</b><small id="settings-mail-status">Checking connected inboxes…</small></span><i>${icon('chevron-right')}</i></button><button class="integration-setting" type="button" data-settings-service="calendar"><span class="home-layout-icon calendar">${icon('calendar-days')}</span><span><b>Calendar</b><small>View upcoming events or grant Calendar access.</small></span><i>${icon('chevron-right')}</i></button></div>`,
    );
    settingsSections[0]?.after(integrationsSection);
    integrationsSection.querySelectorAll('[data-settings-service]').forEach(
      (button) =>
        (button.onclick = () => {
          const service = button.dataset.settingsService;
          if (service === 'model') return modelSetup.show({ afterConfigured: showSettings });
          if (service === 'whatsapp') return whatsappSetup.show({ onBack: showSettings });
          if (service === 'mail') return mail.showSettings({ onBack: showSettings });
          if (service === 'calendar') return calendar.showUpcoming({ onBack: showSettings });
        }),
    );
    fetch('/api/llm/status')
      .then((response) => response.json())
      .then((status) => {
        const target = integrationsSection.querySelector('#settings-model-status');
        if (target)
          target.textContent = status.configured
            ? `${llmProviders[status.provider]?.label || 'Model'} · ${status.model || 'configured'}`
            : 'Connect Ollama, LM Studio, or your own provider.';
      })
      .catch(() => {});
    fetch('/api/mail/status')
      .then((response) => response.json())
      .then((status) => {
        const target = integrationsSection.querySelector('#settings-mail-status');
        const accounts = (status.accounts || []).filter((account) => account.connected);
        if (target)
          target.textContent = accounts.length
            ? accounts.map((account) => account.email).join(' · ')
            : 'Connect Gmail or Zoho Mail with IMAP.';
      })
      .catch(() => {});
    settingsSections[1]?.before(layoutSection);
    const analyticsSection = document.createElement('section');
    analyticsSection.className = 'settings-section home-layout-settings';
    setHtml(
      analyticsSection,
      `<div class="appearance-heading"><span class="briefing-heading">PRODUCT ANALYTICS</span><small>Anonymous. On by default; turn off anytime.</small></div><label class="home-layout-control"><span class="home-layout-icon">${icon('chart-no-axes-combined')}</span><span><b>Help improve Habibi</b><small>Only product events. Never searches, files, messages, contacts, or paths.</small></span><input type="checkbox" id="analytics-enabled" ${analyticsEnabled() ? 'checked' : ''} aria-label="Enable anonymous product analytics" /></label>`,
    );
    layoutSection.after(analyticsSection);
    analyticsSection.querySelector('#analytics-enabled').addEventListener('change', (event) => {
      const enabled = event.currentTarget.checked;
      setAnalyticsEnabled(enabled);
      if (enabled)
        track('habibi.settings.opened', {
          surface: 'analytics-consent',
          outcome: 'enabled',
          app_type: 'native',
          app_version: '0.1.0',
        });
    });
    const onboardingSection = document.createElement('section');
    onboardingSection.className = 'settings-section settings-getting-started';
    onboardingSection.innerHTML = `<div class="appearance-heading"><span class="briefing-heading">GETTING STARTED</span><small>Reconnect or revisit setup any time.</small></div><button class="home-layout-control" id="restart-getting-started" type="button"><span class="home-layout-icon">${icon('rocket')}</span><span><b>Open getting started</b><small>Shortcut, Mail, WhatsApp, and model setup</small></span><i>${icon('arrow-up-right')}</i></button>`;
    analyticsSection.after(onboardingSection);
    if (native) {
      const launchAtLoginSection = document.createElement('section');
      launchAtLoginSection.className = 'settings-section home-layout-settings';
      setHtml(
        launchAtLoginSection,
        `<div class="appearance-heading"><span class="briefing-heading">STARTUP</span><small>Runs quietly in the menu bar after you sign in.</small></div><label class="home-layout-control"><span class="home-layout-icon">${icon('power')}</span><span><b>Start Habibi at login</b><small id="launch-at-login-note">Checking macOS setting…</small></span><input type="checkbox" id="launch-at-login" aria-label="Start Habibi at login" /></label>`,
      );
      onboardingSection.before(launchAtLoginSection);
      const toggle = launchAtLoginSection.querySelector('#launch-at-login');
      const note = launchAtLoginSection.querySelector('#launch-at-login-note');
      window.__habibiLaunchAtLoginState = (result) => {
        if (!toggle?.isConnected) return;
        toggle.checked = Boolean(result?.enabled);
        toggle.disabled = false;
        note.textContent =
          result?.message ||
          (result?.enabled
            ? 'Habibi opens from the menu bar after login.'
            : 'Habibi stays closed until you open it.');
      };
      toggle.addEventListener('change', (event) => {
        toggle.disabled = true;
        note.textContent = event.currentTarget.checked
          ? 'Enabling start at login…'
          : 'Disabling start at login…';
        window.webkit.messageHandlers.habibiNative.postMessage({
          type: 'launchAtLogin',
          enabled: event.currentTarget.checked,
        });
      });
      window.webkit.messageHandlers.habibiNative.postMessage({ type: 'launchAtLoginState' });
    }
    onboardingSection.querySelector('#restart-getting-started').onclick = onRestartOnboarding;
    layoutSection
      .querySelectorAll('[data-home-layout]')
      .forEach((toggle) =>
        toggle.addEventListener('change', () =>
          saveHomeLayout(toggle.dataset.homeLayout, toggle.checked),
        ),
      );
    document.querySelector('#back-settings').onclick = () => {
      shortcutCapture.close();
      onHome();
    };
    resultsView.querySelectorAll('[data-theme-choice]').forEach(
      (button) =>
        (button.onclick = () => {
          applyTheme(button.dataset.themeChoice);
          showSettings();
        }),
    );
    resultsView.querySelectorAll('[data-color-mode]').forEach(
      (button) =>
        (button.onclick = () => {
          applyColorMode(button.dataset.colorMode);
          showSettings();
        }),
    );
    shortcutCapture.install({ native, focus });
  }

  return { applyColorMode, applyTheme, close: shortcutCapture.close, show: showSettings };
}
