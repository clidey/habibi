const { browserUrl } = require('../../core/browser-url');

function createBrowserService({ spawn, approvals }) {
  async function open(value, approvalToken) {
    const url = browserUrl(value);
    if (!url) return { ok: false, error: 'Use an HTTP or HTTPS website address without embedded credentials.' };
    if (!approvals.consume({ token: approvalToken, action: 'browser.open', payload: { url } }))
      return { ok: false, error: 'Opening this website needs approval for this exact address.' };
    return new Promise((resolve) => {
      try {
        const task = spawn('open', [url], { stdio: 'ignore' });
        task.once('error', () => resolve({ ok: false, error: 'The website could not be opened.' }));
        task.once('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: 'The website could not be opened.' }));
      } catch { resolve({ ok: false, error: 'The website could not be opened.' }); }
    });
  }
  return { open };
}

module.exports = { createBrowserService };
