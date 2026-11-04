const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createNotesRouter } = require('../src/server/services/notes-router');
const { applySecurityHeaders, isTrustedLocalRequest } = require('../src/core/http-security');

test('Notes routes enforce local origins, validate requests, and report revision conflicts without leaking raw errors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'habibi-notes-route-'));
  const handle = createNotesRouter(root);
  const server = http.createServer(async (request, response) => {
    applySecurityHeaders(response);
    if (!isTrustedLocalRequest(request)) { response.writeHead(403); response.end(); return; }
    if (!(await handle(request, response, new URL(request.url, 'http://127.0.0.1')))) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (route, method = 'GET', value, extra = {}) => new Promise((resolve, reject) => {
    const task = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { Host: '127.0.0.1:4173', Origin: 'http://127.0.0.1:4173', 'Content-Type': 'application/json', ...extra } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: { get: key => response.headers[key] }, json: async () => JSON.parse(body), text: async () => body }));
    });
    task.on('error', reject); task.end(value === undefined ? undefined : JSON.stringify(value));
  });
  try {
    assert.equal((await request('/api/notes', 'GET', undefined, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await request('/api/notes', 'POST', { title: 'Bad' }, { 'Content-Type': 'text/plain' })).status, 415);
    const created = await (await request('/api/notes', 'POST', { title: 'A private note', body: 'Local content' })).json();
    assert.ok(created.ok);
    const read = await request('/api/notes');
    assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.equal((await read.json()).notes.length, 1);
    assert.equal((await request(`/api/notes/${created.note.id}`, 'PATCH', { body: 'First write', revision: 1 })).status, 200);
    const search = await (await request('/api/notes/search?q=private')).json();
    assert.equal(search.notes[0].id, created.note.id);
    assert.equal(search.notes[0].body, undefined, 'Launcher search returns a short preview, not the complete note body');
    const conflict = await request(`/api/notes/${created.note.id}`, 'PATCH', { body: 'Stale write', revision: 1 });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'conflict');
    const unknown = await request('/api/notes/not-a-note', 'PATCH', { revision: 1 });
    assert.equal(unknown.status, 404);
    assert.doesNotMatch(await unknown.text(), /ENOENT|stack|\.habibi|at Object/);
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});
