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
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).startsWith('/api/kubernetes/overview'))
      return {
        json: async () => ({
          ok: true,
          context: 'dev',
          contexts: ['dev'],
          namespace: '',
          namespaces: ['default'],
          resources: [],
        }),
      };
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
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(opened, 1);
  assert.equal(input.value, 'get pods');
  assert.ok(document.querySelector('.kubernetes-client'));
  assert.match(requests[0].url, /^\/api\/kubernetes\/overview/);

  await feature.runQuery();
  assert.equal(document.querySelector('.kubernetes-query-result')?.textContent, 'pod/api Ready');
  document.querySelector('#back-kubernetes').click();
  assert.equal(backed, 1);
  feature.stop();
  dom.window.close();
});
