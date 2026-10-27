/** Browser destinations only; never hand file paths, credentials, or custom schemes to `open`. */
function browserUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\u0000-\u001f\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function browserCommand(command = '') {
  const value = String(command).trim().replace(/^(?:open|visit|go\s+to|browse(?:\s+to)?)\s+/i, '');
  if (/^https?:\/\//i.test(value)) return browserUrl(value);
  // A bare domain is a destination; common document suffixes remain local-file searches.
  if (!/^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,63}(?::\d{1,5})?(?:[/?#]|$)/u.test(value)) return null;
  if (/\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|md|json|js|ts|png|jpe?g|zip)$/i.test(value)) return null;
  return browserUrl(`https://${value}`);
}

function requestedBrowserUrl(request, destination) {
  const url = browserUrl(destination);
  const supplied = new Set([request, ...String(request).split(/\s+/)].flatMap(value => {
    const clean = value.replace(/^["'(\[]+|["')\],.!]+$/g, '');
    return [browserCommand(value), browserCommand(clean)].filter(Boolean);
  }));
  return url && supplied.has(url) ? url : null;
}

module.exports = { browserUrl, browserCommand, requestedBrowserUrl };
