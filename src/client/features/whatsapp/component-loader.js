export function createWhatsAppComponentLoader() {
  let componentPromise = null;

  function ensureNativeWhatsAppComponent() {
    const bridge = window.webkit?.messageHandlers?.habibiNative;
    if (!bridge) return Promise.resolve();
    if (componentPromise) return componentPromise;
    componentPromise = new Promise((resolve, reject) => {
      const copy = (text) => {
        const line = document.querySelector('#whatsapp-component-copy');
        if (line) line.textContent = text;
      };
      const labels = {
        downloading: 'Downloading WhatsApp support securely…',
        verifying: 'Asking macOS to verify the signed component…',
        starting: 'Starting the private WhatsApp service…',
      };
      const timeout = setTimeout(() => {
        window.__habibiWhatsAppComponent = undefined;
        componentPromise = null;
        reject(new Error('The WhatsApp component took too long to start.'));
      }, 600_000);
      window.__habibiWhatsAppComponent = (status) => {
        if (status?.state === 'downloading' && Number.isInteger(status.progress)) {
          copy(`Downloading WhatsApp support securely… ${status.progress}%`);
        } else if (labels[status?.state]) copy(labels[status.state]);
        if (status?.ok === true) {
          clearTimeout(timeout);
          window.__habibiWhatsAppComponent = undefined;
          componentPromise = null;
          resolve();
        } else if (status?.ok === false) {
          clearTimeout(timeout);
          window.__habibiWhatsAppComponent = undefined;
          componentPromise = null;
          reject(new Error(status.error || 'The WhatsApp component could not be installed.'));
        }
      };
      bridge.postMessage({ type: 'whatsappComponent' });
    });
    return componentPromise;
  }
  // A previously-linked account (real phone/pushName already on the session)
  // that hasn't yet reached `ready` is reconnecting, not setting up for the
  // first time — it needs no QR code and no numbered onboarding steps, just a
  // wait. Only a genuine re-link (a fresh QR actually offered) falls through
  // to the full setup screen below.
  return { ensure: ensureNativeWhatsAppComponent };
}
