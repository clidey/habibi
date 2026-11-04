const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createKubernetesReadService } = require('../src/server/services/kubernetes-read-service');

test('Kubernetes reads reject unsafe flags and audit bounded kubectl calls', async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-kubernetes-read-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.end('pod/api Ready');
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
  const service = createKubernetesReadService({ stateRoot, fs, spawn, kubernetesPlugin: {} });
  const rejected = await service.query('get pods --delete');
  assert.equal(rejected.ok, false);
  assert.equal(calls.length, 0);
  const result = await service.query('get pods -A', 'production');
  assert.equal(result.ok, true);
  assert.equal(result.output, 'pod/api Ready');
  assert.deepEqual(calls, [
    {
      command: 'kubectl',
      args: ['get', 'pods', '--output', 'wide', '--all-namespaces', '--context', 'production'],
    },
  ]);
  const audit = JSON.parse(
    fs.readFileSync(path.join(stateRoot, 'kubernetes/audit.jsonl'), 'utf8').trim(),
  );
  assert.deepEqual(
    { action: audit.action, context: audit.context, exit: audit.exit },
    { action: 'get', context: 'production', exit: 0 },
  );
});
