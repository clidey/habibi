import type { IncomingMessage, ServerResponse } from 'node:http';

const localHosts = new Set(['127.0.0.1:4173', 'localhost:4173', '[::1]:4173']);
const localOrigins = new Set(['http://127.0.0.1:4173', 'http://localhost:4173']);

/**
 * Reject DNS-rebinding and cross-origin requests before they reach a local
 * connector. This is intentionally not authentication: the service is a
 * single-user loopback process, not a network daemon.
 */
export function isTrustedLocalRequest(request: IncomingMessage): boolean {
  const host = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
  if (!host || !localHosts.has(host.toLowerCase())) return false;
  const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
  return !origin || localOrigins.has(origin);
}

/** Apply a conservative browser policy without blocking bundled local assets. */
export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws://127.0.0.1:4173; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' https://unpkg.com; frame-src 'none'; base-uri 'none'; form-action 'none'");
}
