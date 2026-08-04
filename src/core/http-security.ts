import type { IncomingMessage, ServerResponse } from 'node:http';

/** The single source of truth for where the local service listens. */
export const PORT = 4173;
export const HOST = '127.0.0.1';

const localHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const localOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

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

/**
 * True only when the request carries one of this service's own origins.
 *
 * `isTrustedLocalRequest` deliberately accepts a missing Origin so non-browser
 * local callers still work. Endpoints that grant more than a read — the terminal
 * WebSocket, which spawns a login shell — should require positive proof that the
 * caller is the launcher page, since browsers always send Origin on a WebSocket
 * handshake and a bare local process would have to forge it.
 */
export function isBrowserOrigin(request: IncomingMessage): boolean {
  const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
  return Boolean(origin && localOrigins.has(origin));
}

/** Apply a conservative browser policy without blocking bundled local assets. */
export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // `script-src 'self'` only: a third-party script origin such as a CDN serves
  // arbitrary package files, so an injected <script src> would execute despite
  // inline script being blocked. Every dependency is served from /vendor.
  response.setHeader('Content-Security-Policy', `default-src 'self'; connect-src 'self' ws://${HOST}:${PORT}; img-src 'self' data: https:; media-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`);
}
