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
  const keyPath = path.join(workspace, '.openwa/data/.api-key');
  const request = async <T = unknown>(route: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> => {
    const { timeoutMs = 8_000, ...requestOptions } = options;
    const response = await fetch(`${baseUrl}${route}`, { ...requestOptions, signal:AbortSignal.timeout(timeoutMs), headers:{ 'X-API-Key':fs.readFileSync(keyPath, 'utf8').trim(), 'Content-Type':'application/json', ...(requestOptions.headers || {}) } });
    if (!response.ok) throw new Error(`OpenWA request failed (${response.status})`);
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
