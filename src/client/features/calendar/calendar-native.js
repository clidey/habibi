/** Reads upcoming events through the native bridge (EventKit and connected accounts). */
export function createCalendarEventsLoader({ demoMode = false, demoEvents = [] }) {
  return function loadCalendarEvents() {
    if (demoMode) return Promise.resolve({ ok: true, events: demoEvents });
    const nativeBridge = window.webkit?.messageHandlers?.habibiNative;
    // Habibi is the native app; a plain browser has no calendar access at all.
    if (!nativeBridge) return Promise.reject(new Error('Calendar needs the Habibi app.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.__habibiNativeCalendarEvents = null;
        reject(new Error('Calendar did not respond.'));
      }, 10_000);
      window.__habibiNativeCalendarEvents = (payload) => {
        clearTimeout(timer);
        window.__habibiNativeCalendarEvents = null;
        if (payload?.ok) return resolve(payload);
        // A write-only grant is the common case and is recoverable, so name it
        // rather than reporting a generic failure the user cannot act on.
        const reasons = {
          writeOnly:
            'Habibi can only add events. Allow full calendar access in System Settings → Privacy & Security → Calendars.',
          denied:
            'Calendar access is turned off. Allow it in System Settings → Privacy & Security → Calendars.',
          notDetermined: 'Habibi has not been granted calendar access yet.',
          noAccounts: 'Connect a Google or CalDAV calendar in Settings → Calendar.',
        };
        const error = new Error(reasons[payload?.reason] || 'Calendar access is unavailable.');
        error.permissionReason = reasons[payload?.reason] ? payload.reason : null;
        reject(error);
      };
      nativeBridge.postMessage({ type: 'calendarEvents' });
    });
  };
}
