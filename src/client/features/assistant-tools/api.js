let activeRequests = 0;
export async function fileRequest(action, body) {
  const bridge = window.webkit?.messageHandlers?.habibiNative;
  if (++activeRequests === 1) bridge?.postMessage({ type: 'permissionFlow', active: true });
  try {
    const response = await fetch(`/api/file-tools/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'This file action could not be completed.');
    return result;
  } finally {
    if (--activeRequests === 0) bridge?.postMessage({ type: 'permissionFlow', active: false });
  }
}
export async function approve(action, payload) {
  const result = await fetch('/api/approvals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  }).then((response) => response.json());
  if (!result.ok || !result.approval?.token)
    throw new Error('Review the changes and try approval again.');
  return result.approval.token;
}
