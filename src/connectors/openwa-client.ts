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
}

export function createOpenwaClient({ workspace, baseUrl = 'http://127.0.0.1:2785', sessionName = 'habibi' }: OpenwaClientOptions): OpenwaClient {
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
  const sessionState = async (): Promise<OpenwaSessionState> => {
    const sessions = await request<OpenwaSessionRecord[]>('/api/sessions');
    const session = sessions.find(item => item.name === sessionName) || sessions[0] || null;
    let qrCode = null;
    if (session?.status === 'qr_ready') {
      try { qrCode = (await request<{ qrCode?: string }>(`/api/sessions/${session.id}/qr`)).qrCode || null; } catch (_) { /* QR rotates independently. */ }
    }
    return { service:true, session, qrCode };
  };
  const ensureSession = async (): Promise<void> => {
    const sessions = await request<OpenwaSessionRecord[]>('/api/sessions');
    let session = sessions.find(item => item.name === sessionName) || sessions[0];
    if (!session) session = await request<OpenwaSessionRecord>('/api/sessions', { method:'POST', body:JSON.stringify({ name:sessionName, config:{ autoReconnect:true } }) });
    if (!session.engineLoaded) try { await request(`/api/sessions/${session.id}/start`, { method:'POST' }); } catch (_) {}
  };
  return { request, sessionState, ensureSession };
}
