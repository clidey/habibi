import path from 'node:path';

/**
 * The launcher's static surface is small and fully known: one HTML page, one
 * stylesheet, the built client bundle and the logo. Everything else under the
 * workspace root — `.habibi/` provider secrets, `.openwa/` session keys, a
 * `.env`, `package.json`, the `.git` directory — must never be reachable over
 * HTTP, so the handler serves an allowlist rather than filtering a denylist.
 */
const allowedPaths = new Set([
  '/index.html',
  '/app.css',
  '/assets/app.bundle.js',
  '/assets/app.bundle.js.map',
  '/assets/logo.png',
]);

const contentTypes: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export function staticContentType(pathname: string): string {
  return contentTypes[path.extname(pathname).toLowerCase()] || 'application/octet-stream';
}

/**
 * Resolves a request path to a file inside `root`, or null when the request is
 * not an allowlisted asset. `URL` already normalizes `..` segments before this
 * runs; the containment check is the second barrier, and uses a trailing
 * separator so a sibling directory sharing the root's prefix cannot match.
 */
export function resolveStaticAsset(pathname: string, root: string): string | null {
  const requested = pathname === '/' ? '/index.html' : pathname;
  if (!allowedPaths.has(requested)) return null;
  const file = path.resolve(root, `.${requested}`);
  return file === root || file.startsWith(`${root}${path.sep}`) ? file : null;
}
