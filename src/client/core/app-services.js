export function createAppServices({ toast }) {
  function notify(message) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  async function requestApproval(action, payload) {
    const response = await fetch('/api/approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    });
    const result = await response.json();
    if (!result.ok || !result.approval?.token) {
      throw new Error(result.error || 'Could not confirm this action');
    }
    return result.approval.token;
  }

  async function requestNativeLockScreen() {
    const bridge = window.webkit?.messageHandlers?.habibiNative;
    if (!bridge) throw new Error('Lock Screen requires the native Habibi app.');
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.__habibiNativeLockResult = null;
        resolve({ ok: false });
      }, 5_000);
      window.__habibiNativeLockResult = (value) => {
        clearTimeout(timer);
        window.__habibiNativeLockResult = null;
        resolve(value || { ok: false });
      };
      bridge.postMessage({ type: 'lockScreen' });
    });
    if (!result.ok) {
      throw new Error(
        result.permission
          ? 'Allow Habibi in Privacy & Security → Accessibility, then try again.'
          : 'Could not lock this Mac.',
      );
    }
  }

  return { notify, requestApproval, requestNativeLockScreen };
}
