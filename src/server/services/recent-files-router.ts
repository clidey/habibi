import type { IncomingMessage, ServerResponse } from 'node:http';
import type { createRecentFiles } from './recent-files';
export function createRecentFilesRouter(store: ReturnType<typeof createRecentFiles>) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== '/api/recent-files') return false;
    let status = 200;
    let result: unknown;
    try {
      if (request.method === 'GET') result = { ok: true, items: await store.list() };
      else {
        if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || ''))
          throw new Error();
        let body = '';
        for await (const chunk of request) {
          body += String(chunk);
          if (Buffer.byteLength(body) > 8192) throw new Error();
        }
        const data: unknown = JSON.parse(body);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        const value = data as Record<string, unknown>;
        if (request.method === 'POST' && value.action === 'record') await store.record(value.path);
        else if (request.method === 'PATCH') await store.update(value.id, value.pinned);
        else if (request.method === 'DELETE') await store.remove(value.id);
        else throw new Error();
        result = { ok: true };
      }
    } catch {
      status = 400;
      result = { ok: false, error: 'Could not update recent files.' };
    }
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(result));
    return true;
  };
}
