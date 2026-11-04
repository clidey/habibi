const path = require('node:path');

/** Bounded, audited kubectl reads used by the Kubernetes workspace. */
function createKubernetesReadService({ stateRoot, fs, spawn, kubernetesPlugin }) {
  function parseKubernetesReadQuery(input, preferredContext = '') {
    const query = String(input || '')
      .trim()
      .replace(/^(?:k8s|kubernetes)\s+/i, '')
      .replace(/^kubectl\s+/i, '');
    const parts = query.split(/\s+/).filter(Boolean);
    const verb = (parts.shift() || '').toLowerCase();
    const values = [];
    let namespace = '';
    let context = preferredContext;
    let container = '';
    let allNamespaces = false;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === '-n' || part === '--namespace') {
        namespace = parts[++index] || '';
        continue;
      }
      if (part === '--context') {
        context = parts[++index] || '';
        continue;
      }
      if (part === '-c' || part === '--container') {
        container = parts[++index] || '';
        continue;
      }
      if (part === '-A' || part === '--all-namespaces') {
        allNamespaces = true;
        continue;
      }
      if (part.startsWith('-'))
        throw new Error(`Flag ${part} is not available in Habibi's read-only Kubernetes plugin.`);
      values.push(part);
    }
    const resourceAliases = {
      po: 'pods',
      pod: 'pods',
      deploy: 'deployments',
      deployment: 'deployments',
      svc: 'services',
      service: 'services',
      ns: 'namespaces',
      no: 'nodes',
    };
    const resource =
      resourceAliases[(values[0] || '').toLowerCase()] || (values[0] || '').toLowerCase();
    const allowedResources = new Set([
      'pods',
      'deployments',
      'services',
      'statefulsets',
      'daemonsets',
      'replicasets',
      'jobs',
      'cronjobs',
      'configmaps',
      'secrets',
      'ingresses',
      'namespaces',
      'nodes',
      'events',
    ]);
    const withScope = (args) => [
      ...args,
      ...(allNamespaces ? ['--all-namespaces'] : namespace ? ['--namespace', namespace] : []),
      ...(context ? ['--context', context] : []),
    ];
    if (verb === 'events' || (verb === 'get' && resource === 'events'))
      return { action: 'events', args: withScope(['get', 'events']), namespace, context };
    if (verb === 'logs') {
      const pod = values[0];
      if (!pod)
        throw new Error(
          'Say “logs <pod> -n <namespace>”, for example: logs api-7c9d -n production.',
        );
      return {
        action: 'logs',
        args: [
          ...withScope(['logs', pod]),
          ...(container ? ['--container', container] : []),
          '--tail',
          '200',
        ],
        namespace,
        context,
      };
    }
    if (!allowedResources.has(resource))
      throw new Error(
        'Use a read-only query such as “get pods”, “describe deployment api”, “logs api-pod -n production”, or “events -n production”.',
      );
    if (verb === 'get')
      return {
        action: 'get',
        args: withScope(['get', resource, ...(values[1] ? [values[1]] : []), '--output', 'wide']),
        namespace,
        context,
      };
    if (verb === 'describe') {
      if (!values[1])
        throw new Error(
          'Describe needs a resource and name, for example: describe deployment api -n production.',
        );
      return {
        action: 'describe',
        args: withScope(['describe', resource, values[1]]),
        namespace,
        context,
      };
    }
    throw new Error(
      'Habibi only runs read-only Kubernetes commands: get, describe, logs, and events.',
    );
  }

  function appendKubernetesAudit({ action, namespace, context, exitCode }) {
    try {
      const directory = path.join(stateRoot, 'kubernetes');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.appendFileSync(
        path.join(directory, 'audit.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), action, namespace: namespace || null, context: context || null, exit: exitCode })}\n`,
        { mode: 0o600 },
      );
    } catch (_) {
      /* Auditing must never make a read-only inspection unavailable. */
    }
  }

  function runKubectlRead(args, audit, { maxOutputBytes = 500_000 } = {}) {
    return new Promise((resolve) => {
      const task = spawn('kubectl', args);
      let stdout = '';
      let stderr = '';
      let settled = false;
      let outputTooLarge = false;
      const finish = (payload, exitCode) => {
        if (settled) return;
        settled = true;
        appendKubernetesAudit({ ...audit, exitCode });
        resolve(payload);
      };
      const timer = setTimeout(() => {
        task.kill('SIGTERM');
        finish({ ok: false, error: 'kubectl timed out after 10 seconds.' }, 124);
      }, 10_000);
      task.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.length > maxOutputBytes) {
          outputTooLarge = true;
          task.kill('SIGTERM');
        }
      });
      task.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      task.on('error', (error) => {
        clearTimeout(timer);
        finish(
          {
            ok: false,
            error:
              error.code === 'ENOENT'
                ? 'kubectl is not installed or not on Habibi’s PATH.'
                : 'Could not start kubectl.',
          },
          127,
        );
      });
      task.on('close', (code) => {
        clearTimeout(timer);
        finish(
          outputTooLarge
            ? {
                ok: false,
                error:
                  'This Kubernetes response is too large to display safely. Narrow the namespace or resource.',
              }
            : code === 0
              ? { ok: true, output: stdout }
              : { ok: false, error: (stderr || 'kubectl failed.').trim().slice(0, 4_000) },
          code ?? 1,
        );
      });
    });
  }

  function runKubernetesReadQuery(input, preferredContext = '', preferredNamespace = '') {
    let parsed;
    try {
      parsed = parseKubernetesReadQuery(input, preferredContext);
    } catch (error) {
      return Promise.resolve({ ok: false, error: error.message });
    }
    // A command that already names a scope always wins. Otherwise the explorer's
    // namespace selector provides the safe default scope for a read.
    if (preferredNamespace && !parsed.namespace && !parsed.args.includes('--all-namespaces')) {
      const insertion = parsed.args.findIndex((value) => value === '--context');
      parsed.args.splice(
        insertion < 0 ? parsed.args.length : insertion,
        0,
        '--namespace',
        preferredNamespace,
      );
      parsed.namespace = preferredNamespace;
    }
    return runKubectlRead(parsed.args, parsed).then((result) => ({
      ...result,
      action: parsed.action,
    }));
  }

  async function kubernetesOverview(requestedContext, requestedNamespace = '') {
    const contextsResult = await runKubectlRead(['config', 'get-contexts', '-o', 'name'], {
      action: 'contexts',
      namespace: '',
      context: '',
    });
    if (!contextsResult.ok)
      return { ok: false, error: contextsResult.error, contexts: [], resources: [] };
    const contexts = contextsResult.output
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 100);
    const currentResult = await runKubectlRead(['config', 'current-context'], {
      action: 'current-context',
      namespace: '',
      context: '',
    });
    const current = currentResult.ok ? currentResult.output.trim() : '';
    const context = contexts.includes(requestedContext)
      ? requestedContext
      : contexts.includes(current)
        ? current
        : contexts[0] || '';
    if (requestedNamespace && !validKubernetesName(requestedNamespace, 62))
      return { ok: false, error: 'That namespace is not valid.', contexts, resources: [] };
    const scoped = (args) => [...args, ...(context ? ['--context', context] : [])];
    const namespacesResult = await runKubectlRead(
      scoped(['get', 'namespaces', '--output', 'json']),
      { action: 'namespaces', namespace: '', context },
      { maxOutputBytes: 1_000_000 },
    );
    const namespaces = namespacesResult.ok
      ? (() => {
          try {
            return JSON.parse(namespacesResult.output)
              .items.map((item) => item.metadata?.name)
              .filter(Boolean)
              .sort();
          } catch (_) {
            return [];
          }
        })()
      : [];
    const namespace = namespaces.includes(requestedNamespace) ? requestedNamespace : '';
    const scope = namespace ? ['--namespace', namespace] : ['--all-namespaces'];
    const specs = [
      ['pods', ['get', 'pods', ...scope, '--output', 'json']],
      ['deployments', ['get', 'deployments', ...scope, '--output', 'json']],
      ['services', ['get', 'services', ...scope, '--output', 'json']],
    ];
    const resources = await Promise.all(
      specs.map(async ([kind, args]) => {
        // The overview needs enough of a list response to parse and compact it,
        // then exposes only the first 80 rows. Arbitrary user queries retain the
        // much smaller default output limit above.
        const result = await runKubectlRead(
          scoped(args),
          { action: `overview-${kind}`, namespace, context },
          { maxOutputBytes: 4_000_000 },
        );
        if (!result.ok) return { kind, ...result, items: [] };
        try {
          return {
            kind,
            ok: true,
            items: kubernetesOverviewItems(kind, JSON.parse(result.output).items || []),
          };
        } catch (_) {
          return {
            kind,
            ok: false,
            error: `Could not read ${kind} returned by kubectl.`,
            items: [],
          };
        }
      }),
    );
    return { ok: true, contexts, context, namespaces, namespace, resources };
  }

  function kubernetesOverviewItems(kind, items) {
    return items.slice(0, 80).map((item) => {
      const metadata = item.metadata || {};
      const status = item.status || {};
      const spec = item.spec || {};
      const base = {
        namespace: metadata.namespace || 'default',
        name: metadata.name || 'Unnamed resource',
        createdAt: metadata.creationTimestamp || '',
      };
      if (kind === 'pods') {
        const containers = status.containerStatuses || [];
        const ready = containers.filter((container) => container.ready).length;
        return {
          ...base,
          primary: status.phase || 'Unknown',
          secondary: `${ready}/${containers.length || 0} ready`,
          badge: containers.reduce((total, container) => total + (container.restartCount || 0), 0)
            ? `${containers.reduce((total, container) => total + (container.restartCount || 0), 0)} restarts`
            : '',
        };
      }
      if (kind === 'deployments')
        return {
          ...base,
          primary: `${status.readyReplicas || 0}/${spec.replicas || 0} ready`,
          secondary: status.availableReplicas
            ? `${status.availableReplicas} available`
            : 'No available replicas',
          badge: '',
        };
      if (kind === 'services')
        return {
          ...base,
          primary: spec.type || 'ClusterIP',
          secondary:
            (spec.ports || [])
              .map((port) => `${port.port}${port.name ? `/${port.name}` : ''}`)
              .join(' · ') || 'No ports',
          badge: spec.clusterIP && spec.clusterIP !== 'None' ? spec.clusterIP : '',
        };
      const conditions = status.conditions || [];
      const ready =
        conditions.find((condition) => condition.type === 'Ready') ||
        conditions.find((condition) => condition.status === 'True');
      return {
        ...base,
        primary: ready ? `${ready.type}: ${ready.status}` : status.phase || item.kind || 'Resource',
        secondary: metadata.creationTimestamp
          ? `Created ${new Date(metadata.creationTimestamp).toLocaleDateString()}`
          : 'Cluster resource',
        badge: '',
      };
    });
  }

  const kubernetesKinds = new Set([
    'pods',
    'deployments',
    'services',
    'statefulsets',
    'daemonsets',
    'replicasets',
    'jobs',
    'cronjobs',
    'configmaps',
    'secrets',
    'ingresses',
    'namespaces',
    'nodes',
    'events',
  ]);
  function normalizedKubernetesKind(value) {
    const aliases = {
      pod: 'pods',
      deploy: 'deployments',
      deployment: 'deployments',
      svc: 'services',
      service: 'services',
      ds: 'daemonsets',
      sts: 'statefulsets',
      rs: 'replicasets',
      job: 'jobs',
      cronjob: 'cronjobs',
      ns: 'namespaces',
      node: 'nodes',
    };
    const kind = aliases[String(value || '').toLowerCase()] || String(value || '').toLowerCase();
    return kubernetesKinds.has(kind) ? kind : '';
  }
  function validKubernetesName(value, max = 252) {
    return (
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(String(value || '')) && String(value).length <= max
    );
  }
  function kubernetesScope(kind, namespace, context, allNamespaces = false) {
    return [
      ...(allNamespaces && !['nodes', 'namespaces'].includes(kind)
        ? ['--all-namespaces']
        : namespace && !['nodes', 'namespaces'].includes(kind)
          ? ['--namespace', namespace]
          : []),
      ...(context ? ['--context', context] : []),
    ];
  }
  async function kubernetesResourceList(payload = {}) {
    const kind = normalizedKubernetesKind(payload.kind);
    const context = String(payload.context || '').trim();
    const namespace = String(payload.namespace || '').trim();
    if (!kind)
      return {
        ok: false,
        error: 'That Kubernetes resource is not available in the read-only explorer.',
      };
    if (namespace && !validKubernetesName(namespace, 62))
      return { ok: false, error: 'That namespace is not valid.' };
    const result = await runKubectlRead(
      ['get', kind, ...kubernetesScope(kind, namespace, context, !namespace), '--output', 'json'],
      { action: `browse-${kind}`, namespace, context },
      { maxOutputBytes: 4_000_000 },
    );
    if (!result.ok) return result;
    try {
      return {
        ok: true,
        kind,
        items: kubernetesOverviewItems(kind, JSON.parse(result.output).items || []).slice(0, 150),
      };
    } catch (_) {
      return { ok: false, error: `Could not read ${kind} returned by kubectl.` };
    }
  }

  async function kubernetesResourceDetail(payload = {}) {
    const kind = normalizedKubernetesKind(payload.kind);
    const name = String(payload.name || '').trim();
    const namespace = String(payload.namespace || '').trim();
    const context = String(payload.context || '').trim();
    if (!kind || !validKubernetesName(name))
      return { ok: false, error: 'That resource is not available for inspection.' };
    if (namespace && !validKubernetesName(namespace, 62))
      return { ok: false, error: 'That namespace is not valid.' };
    const args = [
      'get',
      kind,
      name,
      ...kubernetesScope(kind, namespace, context),
      '--output',
      'json',
    ];
    const result = await runKubectlRead(args, { action: `detail-${kind}`, namespace, context });
    if (!result.ok) return result;
    try {
      const value = JSON.parse(result.output);
      const detail = formatKubernetesDetail(kind, value);
      const selector = Object.entries(value.spec?.selector?.matchLabels || {})
        .map(([key, label]) => `${key}=${label}`)
        .join(',');
      if (
        selector &&
        ['deployments', 'jobs', 'statefulsets', 'daemonsets', 'replicasets'].includes(kind) &&
        namespace
      ) {
        const pods = await runKubectlRead(
          [
            'get',
            'pods',
            '--namespace',
            namespace,
            '--selector',
            selector,
            '--output',
            'json',
            ...(context ? ['--context', context] : []),
          ],
          { action: `related-pods-${kind}`, namespace, context },
          { maxOutputBytes: 1_500_000 },
        );
        if (pods.ok)
          detail.relatedPods = kubernetesOverviewItems(
            'pods',
            JSON.parse(pods.output).items || [],
          ).slice(0, 50);
      }
      return { ok: true, detail };
    } catch (_) {
      return { ok: false, error: 'kubectl returned a resource Habibi could not read.' };
    }
  }

  async function kubernetesPodLogs(payload = {}) {
    const pod = String(payload.pod || '').trim();
    const namespace = String(payload.namespace || '').trim();
    const context = String(payload.context || '').trim();
    const container = String(payload.container || '').trim();
    if (
      !validKubernetesName(pod) ||
      !validKubernetesName(namespace, 62) ||
      (container && !validKubernetesName(container))
    )
      return { ok: false, error: 'Choose a valid pod and namespace to read logs.' };
    const result = await runKubectlRead(
      [
        'logs',
        pod,
        '--namespace',
        namespace,
        ...(container ? ['--container', container] : []),
        '--tail',
        '200',
        ...(context ? ['--context', context] : []),
      ],
      { action: 'logs', namespace, context },
      { maxOutputBytes: 1_000_000 },
    );
    return result.ok ? { ok: true, output: result.output, pod, namespace, container } : result;
  }

  function formatKubernetesDetail(kind, value) {
    const metadata = value.metadata || {};
    const status = value.status || {};
    const spec = value.spec || {};
    const statuses = status.containerStatuses || [];
    const containers = (spec.containers || []).slice(0, 30).map((container) => {
      const runtime = statuses.find((item) => item.name === container.name) || {};
      const state = runtime.state || {};
      return {
        name: container.name || 'container',
        image: container.image || '',
        state: Object.keys(state)[0] || (runtime.ready ? 'Running' : 'Unknown'),
        ready: Boolean(runtime.ready),
        restarts: runtime.restartCount || 0,
      };
    });
    const conditions = (status.conditions || []).slice(0, 12).map((condition) => ({
      type: condition.type || 'Condition',
      status: condition.status || 'Unknown',
      reason: condition.reason || '',
      message: condition.message || '',
    }));
    const facts = [];
    if (kind === 'pods')
      facts.push(
        ['Phase', status.phase || 'Unknown'],
        ['Node', spec.nodeName || 'Pending'],
        ['IP', status.podIP || '—'],
      );
    if (kind === 'deployments')
      facts.push(
        ['Ready', `${status.readyReplicas || 0}/${spec.replicas || 0}`],
        ['Available', String(status.availableReplicas || 0)],
        ['Updated', String(status.updatedReplicas || 0)],
      );
    if (kind === 'services')
      facts.push(
        ['Type', spec.type || 'ClusterIP'],
        ['Cluster IP', spec.clusterIP || '—'],
        [
          'Ports',
          (spec.ports || []).map((port) => `${port.port}/${port.protocol || 'TCP'}`).join(' · ') ||
            '—',
        ],
      );
    if (!facts.length)
      facts.push(
        ['Created', metadata.creationTimestamp || '—'],
        ['Labels', String(Object.keys(metadata.labels || {}).length)],
        ['Annotations', String(Object.keys(metadata.annotations || {}).length)],
      );
    return {
      kind,
      name: metadata.name || 'Unnamed resource',
      namespace: metadata.namespace || '',
      facts,
      containers,
      conditions,
      labels: Object.entries(metadata.labels || {})
        .slice(0, 16)
        .map(([key, label]) => ({ key, value: String(label) })),
    };
  }

  async function planKubernetesNaturalQuery(query, preferredContext, preferredNamespace = '') {
    const plan = await kubernetesPlugin.plan({ request: query });
    if (!plan.ok) return plan;
    const result = await runKubernetesReadQuery(plan.query, preferredContext, preferredNamespace);
    return {
      ...result,
      plannedQuery: plan.query,
      summary: plan.summary,
      trace: [
        {
          tool: 'Local intent planner',
          detail: 'Translated your request into a constrained read-only query.',
        },
        {
          tool: 'kubectl read',
          detail: result.ok
            ? 'Read completed using your selected context.'
            : 'The read was rejected or could not complete.',
        },
      ],
    };
  }

  async function diagnoseKubernetes(query, preferredContext, preferredNamespace = '') {
    try {
      return await kubernetesPlugin.diagnose({
        request: query,
        context: preferredContext,
        namespace: preferredNamespace,
        tools: {
          overview: (context, namespace) => kubernetesOverview(context, namespace),
          detail: (payload) => kubernetesResourceDetail(payload),
          logs: (payload) => kubernetesPodLogs(payload),
        },
      });
    } catch (error) {
      console.error('[Habibi Kubernetes diagnosis]', error?.stack || error?.message || error);
      return {
        ok: false,
        error:
          'The Kubernetes investigation could not complete. Check the selected context and try again.',
      };
    }
  }

  return {
    query: runKubernetesReadQuery,
    plan: planKubernetesNaturalQuery,
    diagnose: diagnoseKubernetes,
    resources: kubernetesResourceList,
    detail: kubernetesResourceDetail,
    logs: kubernetesPodLogs,
    overview: kubernetesOverview,
  };
}

module.exports = { createKubernetesReadService };
