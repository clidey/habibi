const http = require('node:http');
const { randomBytes, createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { createWhoDbKeychain } = require('./whodb-keychain');

const failure = () => ({ ok: false, error: 'WhoDB sign-in failed or expired. Try signing in again.' });

/** HTTPS for hosted instances; plain HTTP is restricted to loopback development. */
function whoDbUrl(value = 'https://app.whodb.com') {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid WhoDB URL.');
  return url;
}

/** Match the CLI's completion page, including its local backend/frontend port mapping. */
function whoDbConnectedUrl(host) {
  const url = whoDbUrl(host);
  if (url.port === '8080' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.port = '3000';
  return `${url.href.replace(/\/$/, '')}/mcp-connected`;
}

/** Bounded auth/API reads never follow redirects carrying credentials to a different host. */
async function whoDbJson(fetcher, url, options = {}) {
  const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('WhoDB response is too large.');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!response.ok) throw new Error('WhoDB request failed.');
  return data;
}

/** CLI-compatible OIDC code + PKCE login. Only an active login owns a callback listener. */
function createWhoDbAuth({ store = createWhoDbKeychain(), fetcher = fetch, onConnected = () => {}, loginTimeout = 300_000, openBrowser = (url) => new Promise((resolve, reject) => execFile('/usr/bin/open', [url], (error) => error ? reject(error) : resolve())) } = {}) {
  let pending = null;
  let refreshing = null;
  let cached = null;
  async function metadata(host) {
    const config = await whoDbJson(fetcher, `${host}/api/auth-config`);
    if (config.version !== 2 || typeof config.clientId !== 'string' || !config.clientId || config.flows?.authorizationCodePkce !== true) throw new Error('Unsupported WhoDB authentication.');
    const issuer = whoDbUrl(config.issuer).href.replace(/\/$/, '');
    const discovery = await whoDbJson(fetcher, `${issuer}/.well-known/openid-configuration`);
    if (discovery.issuer?.replace(/\/$/, '') !== issuer) throw new Error('Issuer mismatch.');
    for (const endpoint of [discovery.authorization_endpoint, discovery.token_endpoint]) {
      if (whoDbUrl(endpoint).origin !== new URL(issuer).origin) throw new Error('OIDC endpoint origin mismatch.');
    }
    return { clientId: config.clientId, discovery };
  }
  async function exchange(meta, values) {
    const data = await whoDbJson(fetcher, meta.discovery.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: meta.clientId, ...values }).toString(),
    });
    if (typeof data.access_token !== 'string' || !data.access_token || data.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Invalid token response.');
    return { accessToken: data.access_token, refreshToken: data.refresh_token || '', expiresAt: Date.now() + data.expires_in * 1000 };
  }
  async function begin(rawHost) {
    if (pending && !pending.done) return { ok: false, error: 'WhoDB sign-in is already open. Finish it in your browser or cancel it first.' };
    const flow = { id: randomBytes(24).toString('base64url'), done: false };
    pending = flow;
    try {
      const host = whoDbUrl(rawHost || 'https://app.whodb.com').origin;
      const meta = await metadata(host);
      if (pending !== flow || flow.done) throw new Error('Login cancelled.');
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      let resolve;
      flow.result = new Promise((done) => { resolve = done; });
      let timer;
      flow.finish = (result) => {
        if (flow.done) return;
        flow.done = true;
        clearTimeout(timer);
        flow.server.close();
        resolve(result);
      };
      let received = false;
      flow.server = http.createServer(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        response.setHeader('Referrer-Policy', 'no-referrer');
        const expectedHost = `127.0.0.1:${flow.server.address()?.port}`;
        const url = new URL(request.url, 'http://127.0.0.1');
        if (request.method !== 'GET' || request.headers.host !== expectedHost || url.pathname !== '/') return response.writeHead(404).end();
        if (url.searchParams.get('state') !== state || received || flow.done) return response.writeHead(400).end('Invalid sign-in callback.');
        received = true;
        if (url.searchParams.has('error') || !url.searchParams.get('code')) {
          response.writeHead(400).end('Sign-in cancelled. Return to Habibi.');
          return flow.finish(failure());
        }
        try {
          const tokens = await exchange(meta, { grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: flow.redirect, code_verifier: verifier });
          if (flow.done) throw new Error('Login expired.');
          await store.set(host, tokens);
          if (flow.done) throw new Error('Login cancelled.');
          await onConnected(host);
          cached = { host, ...tokens };
          response.writeHead(302, { Location: whoDbConnectedUrl(host) }).end();
          flow.finish({ ok: true });
        } catch {
          response.writeHead(400).end('Could not finish sign-in. Return to Habibi and try again.');
          flow.finish(failure());
        }
      });
      flow.server.headersTimeout = 10_000;
      flow.server.requestTimeout = 30_000;
      await new Promise((resolve, reject) => {
        flow.server.once('error', reject);
        flow.server.listen(0, '127.0.0.1', resolve);
      });
      flow.redirect = `http://127.0.0.1:${flow.server.address().port}`;
      timer = setTimeout(() => flow.finish(failure()), loginTimeout);
      timer.unref();
      const authorization = new URL(meta.discovery.authorization_endpoint);
      authorization.search = new URLSearchParams({ response_type: 'code', scope: 'openid profile email offline_access', redirect_uri: flow.redirect, client_id: meta.clientId, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      flow.url = authorization.href;
      return { ok: true, id: flow.id, url: authorization.href, host };
    } catch {
      flow.finish?.(failure());
      flow.done = true;
      return failure();
    }
  }
  async function token(host, force = false) {
    if (refreshing) await refreshing;
    const saved = cached?.host === host ? cached : await store.get(host);
    if (!saved) throw Object.assign(new Error('Your saved WhoDB session could not be restored. Sign in again.'), { code: 'WHODB_SIGN_IN_REQUIRED' });
    if (!force && saved.expiresAt > Date.now() + 30_000) { cached = { ...saved, host }; return saved.accessToken; }
    if (!saved.refreshToken) throw Object.assign(new Error('Your WhoDB session expired. Sign in again.'), { code: 'WHODB_SIGN_IN_REQUIRED' });
    refreshing = (async () => {
      const tokens = await exchange(await metadata(host), { grant_type: 'refresh_token', refresh_token: saved.refreshToken });
      tokens.refreshToken ||= saved.refreshToken;
      await store.set(host, tokens);
      cached = { host, ...tokens };
    })();
    try { await refreshing; } finally { refreshing = null; }
    return cached.accessToken;
  }
  return {
    begin, token,
    open: async (id) => {
      if (pending?.id !== id || pending.done || !pending.url) return failure();
      try { await openBrowser(pending.url); return { ok: true }; } catch { return failure(); }
    },
    wait: (id) => pending?.id === id ? pending.result || Promise.resolve(failure()) : Promise.resolve(failure()),
    cancel: (id) => { if (pending?.id === id) { pending.finish?.(failure()); pending.done = true; } return { ok: true }; },
  };
}
module.exports = { createWhoDbAuth, whoDbUrl, whoDbJson, whoDbConnectedUrl };
