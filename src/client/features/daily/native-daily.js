const pending = (window.__habibiDailyPending ||= new Map());
let sequence = 0;
window.__habibiDailyResult = (value) => {
  const request = pending.get(value?.requestId);
  if (!request) return;
  pending.delete(value.requestId);
  clearTimeout(request.timer);
  if (value.ok) request.resolve(value);
  else request.reject(new Error(value.error || 'This action could not be completed.'));
};
export function nativeDaily(action, value = {}) {
  const bridge = window.webkit?.messageHandlers?.habibiNative;
  if (!bridge) return Promise.reject(new Error('Open Habibi for Mac to use this utility.'));
  const requestId = `daily-${Date.now()}-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        pending.delete(requestId);
        reject(new Error('The Mac utility did not respond. Try again.'));
      },
      action === 'reminders.access' ? 120000 : 15000,
    );
    pending.set(requestId, { resolve, reject, timer });
    bridge.postMessage({ ...value, type: 'dailyUtility', action, requestId });
  });
}
