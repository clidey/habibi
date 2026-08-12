import fs from 'node:fs';
import path from 'node:path';
import type { OpenwaSession } from '../contracts/whatsapp';

export interface OpenwaSessionRecord extends OpenwaSession {
  engineLoaded?: boolean;
}

export interface OpenwaSessionState {
  service: true;
  session: OpenwaSessionRecord | null;
  qrCode: string | null;
}

export interface OpenwaClient {
  request<T = unknown>(route: string, options?: RequestInit & { timeoutMs?: number }): Promise<T>;
  sessionState(): Promise<OpenwaSessionState>;
  ensureSession(): Promise<void>;
}

export interface OpenwaClientOptions {
  workspace: string;
  baseUrl?: string;
  sessionName?: string;
  /** How long a session may sit in a healable status before being force-killed and recreated. Overridable for tests; production keeps the default. */
  staleAfterMs?: number;
}

export function createOpenwaClient({ workspace, baseUrl = 'http://127.0.0.1:2785', sessionName = 'habibi', staleAfterMs = 45_000 }: OpenwaClientOptions): OpenwaClient {
  // OpenWA (github.com/rmyndharis/OpenWA) generates this key itself on first run
  // and writes it relative to its own working directory or BOOTSTRAP_KEY_FILE —
  // see README "Connect WhatsApp" for the exact command. It never lives here
  // until that server has been started once.
  const keyPath = path.join(workspace, '.openwa/data/.api-key');
  const readKey = (): string => {
    try { return fs.readFileSync(keyPath, 'utf8').trim(); }
    catch { throw new Error('WhatsApp gateway is not set up. See the README for how to run OpenWA.'); }
  };
  const request = async <T = unknown>(route: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> => {
    const { timeoutMs = 8_000, ...requestOptions } = options;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${route}`, { ...requestOptions, signal:AbortSignal.timeout(timeoutMs), headers:{ 'X-API-Key':readKey(), 'Content-Type':'application/json', ...(requestOptions.headers || {}) } });
    } catch (error) {
      // A closed connection means nothing is listening on baseUrl; readKey's own
      // message already covers a missing key.
      if (error instanceof Error && error.message.startsWith('WhatsApp gateway')) throw error;
      throw new Error('WhatsApp gateway is not running. See the README for how to start OpenWA.');
    }
    if (!response.ok) throw new Error(`WhatsApp gateway request failed (${response.status})`);
    return (response.status === 204 ? null : await response.json()) as T;
  };
  // OpenWA's session record lives in its own SQLite DB under the state root,
  // entirely independent of the app or WhatsApp-component version — replacing
  // or upgrading the component does nothing to unstick a session whose engine
  // crashed or never finished launching (e.g. a Chromium launch failure).
  // Left alone, that session is reported as-is forever, and recovering meant
  // deleting .openwa by hand. sessionState() is polled automatically every
  // 1.5s by the setup UI already, so tracking staleness here — and force-
  // healing past a threshold — makes recovery transparent: no new endpoint,
  // no client change, and it also covers the case where nothing is polling
  // (a session left stuck from a previous run self-corrects the next time
  // anything calls status or connect).
  // Only pre-link failure states are eligible for auto-healing. 'disconnected'
  // is deliberately excluded even though it is not "progressing": the session
  // was already created with autoReconnect:true, so OpenWA's own reconnect
  // logic owns recovering from that — force-killing a disconnected session
  // would destroy a real linked WhatsApp device and force an unnecessary
  // re-scan, which is strictly worse than staying disconnected a while longer.
  const healableStatuses = new Set(['created', 'initializing', 'failed']);
  let stuckSessionId: string | null = null;
  let stuckSince = 0;

  const startSession = async (session: OpenwaSessionRecord): Promise<void> => {
    if (!session.engineLoaded) try { await request(`/api/sessions/${session.id}/start`, { method:'POST' }); } catch (_) {}
  };

  const createSession = async (): Promise<OpenwaSessionRecord> => {
    const session = await request<OpenwaSessionRecord>('/api/sessions', { method:'POST', body:JSON.stringify({ name:sessionName, config:{ autoReconnect:true } }) });
    await startSession(session);
    return session;
  };

  /** Force-kill and delete a session that has shown no progress for too long. Best-effort: a failure here just means the next check tries again. */
  const healStuckSession = async (sessionId: string): Promise<void> => {
    try { await request(`/api/sessions/${sessionId}/force-kill`, { method:'POST' }); } catch (_) {}
    try { await request(`/api/sessions/${sessionId}`, { method:'DELETE' }); } catch (_) {}
  };

  /** Resolve the current named session, healing it in place if it has been stuck past the threshold. Returns null only when a stuck session was just killed — the caller decides whether to recreate. */
  const currentSession = async (): Promise<OpenwaSessionRecord | null> => {
    const sessions = await request<OpenwaSessionRecord[]>('/api/sessions');
    const session = sessions.find(item => item.name === sessionName) || sessions[0] || null;
    if (!session) { stuckSessionId = null; return null; }
    if (!healableStatuses.has(session.status)) { stuckSessionId = null; return session; }
    const now = Date.now();
    if (stuckSessionId !== session.id) { stuckSessionId = session.id; stuckSince = now; return session; }
    if (now - stuckSince <= staleAfterMs) return session;
    stuckSessionId = null;
    await healStuckSession(session.id);
    return null;
  };

  const sessionState = async (): Promise<OpenwaSessionState> => {
    let session = await currentSession();
    // A session just healed away is recreated immediately (not left null for
    // the caller to notice and retry): the setup UI's own poll loop only
    // keeps polling while it sees a truthy session, so returning null here
    // would silently strand it on a stale screen instead of recovering.
    if (!session) session = await createSession();
    let qrCode = null;
    if (session.status === 'qr_ready') {
      try { qrCode = (await request<{ qrCode?: string }>(`/api/sessions/${session.id}/qr`)).qrCode || null; } catch (_) { /* QR rotates independently. */ }
    }
    return { service:true, session, qrCode };
  };
  const ensureSession = async (): Promise<void> => {
    let session = await currentSession();
    if (!session) session = await createSession();
    else await startSession(session);
  };
  return { request, sessionState, ensureSession };
}
