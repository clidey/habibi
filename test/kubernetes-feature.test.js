const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('Kubernetes controller owns its view, routing callbacks, and queries', async () => {
  const dom = new JSDOM(
    '<input id="command"><main id="home"></main><main id="results" class="hidden"></main><span id="count"></span>',
    { url: 'http://127.0.0.1:4173/' },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = (callback) => callback();
  const requests = [];
  let finishOverview;
  let deferOverview = true;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).startsWith('/api/kubernetes/overview')) {
      if (deferOverview) await new Promise(resolve => { finishOverview = resolve; deferOverview = false; });
      const params = new URL(String(url), 'http://127.0.0.1:4173').searchParams;
      return {
        json: async () => ({
          ok: true,
          context: params.get('context') || 'dev',
          contexts: ['dev', 'production'],
          namespace: params.get('namespace') || '',
          namespaces: ['default'],
          resources: [],
        }),
      };
    }
    if (url === '/api/kubernetes/resources') return { json: async () => ({ ok: true, kind: JSON.parse(options.body).kind, items: [] }) };
    return { json: async () => ({ ok: true, action: 'get', output: 'pod/api Ready' }) };
  };
  let opened = 0;
  let backed = 0;
  const { createKubernetesFeature } =
    await import('../src/client/features/kubernetes/kubernetes-feature.js');
  const input = document.querySelector('#command');
  const feature = createKubernetesFeature({
    input,
    defaultView: document.querySelector('#home'),
    resultsView: document.querySelector('#results'),
    count: document.querySelector('#count'),
    onOpen: () => {
      opened += 1;
    },
    onBack: () => {
      backed += 1;
    },
  });

  feature.show('k8s get pods');
  assert.equal(requests.length, 1, 'initial queries must wait for context discovery');
  assert.ok(document.querySelector('[role="status"]'));
  assert.equal(document.querySelector('.kubernetes-loading-skeleton'), null);
  finishOverview();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(opened, 1);
  assert.equal(input.value, 'get pods');
  assert.ok(document.querySelector('.kubernetes-client'));
  assert.match(requests[0].url, /^\/api\/kubernetes\/overview/);
  assert.equal(JSON.parse(requests.find(request => request.url === '/api/kubernetes/query').options.body).context, 'dev');
  assert.equal(document.querySelectorAll('#kubernetes-samples button').length, 4);
  document.querySelector('[data-kubernetes-context="production"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  document.querySelector('[data-kubernetes-namespace="default"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));

  await feature.runQuery();
  const query = JSON.parse(requests.filter(request => request.url === '/api/kubernetes/query').at(-1).options.body);
  assert.equal(query.context, 'production');
  assert.equal(query.namespace, 'default');
  assert.equal(document.querySelector('.kubernetes-query-result')?.textContent, 'pod/api Ready');
  const more = document.querySelector('#kubernetes-more-resources');
  more.value = 'nodes';
  more.dispatchEvent(new dom.window.Event('change'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(JSON.parse(requests.find(request => request.url === '/api/kubernetes/resources').options.body).kind, 'nodes');
  document.querySelector('#back-kubernetes').click();
  assert.equal(backed, 1);
  feature.stop();
  dom.window.close();
});
