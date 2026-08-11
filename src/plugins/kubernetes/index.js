/** Kubernetes plugin: own manifest, planning, and safe local integration. */
// Keep the runtime declaration in JavaScript because the native service bundle
// copies executable modules, not adjacent JSON assets. manifest.json remains
// the portable/plugin-discovery declaration with the same fields.
const manifest = Object.freeze({
  id:'kubernetes',
  name:'Kubernetes',
  version:'0.1.0',
  kind:'extension',
  permissions:['kubernetes.read', 'audit.local'],
  commands:['Open Kubernetes', 'Diagnose a Kubernetes workload', 'Inspect a Kubernetes resource'],
  tools:[
    { name:'list_resources', description:'List cluster resources in a context and optional namespace', readOnly:true },
    { name:'inspect_resource', description:'Read structured workload, pod, service, or event details', readOnly:true },
    { name:'read_logs', description:'Read a bounded tail of pod logs', readOnly:true },
    { name:'diagnose', description:'Investigate a workload by sequencing safe cluster reads and summarizing evidence', readOnly:true }
  ]
});

function createKubernetesPlugin({ llmService }) {
  async function plan({ request }) {
    const configured = await llmService.configured();
    if (!configured.configured || !['ollama', 'lmstudio'].includes(configured.provider)) return { ok:false, error:'Configure a local model to interpret Kubernetes requests, or use a kubectl-style command.' };
    const systemPrompt = `You are the Kubernetes Habibi plugin. Turn the user's request into exactly one safe kubectl-style command. Return JSON only: {"query":"...","summary":"..."}. The query must begin with one of: get, describe, logs, events. You may use only these resources: pods, deployments, services, statefulsets, daemonsets, replicasets, jobs, cronjobs, configmaps, secrets, ingresses, namespaces, nodes, events. You may use only -n <namespace>, -A, --context <context>, and -c <container>. Do not include pipes, shell syntax, labels, jsonpath, watch, edit, delete, apply, exec, port-forward, proxy, or any write operation. Preserve namespace and resource names from the user exactly; never invent them. If a request is ambiguous, choose a broad list such as get pods -A and say what was broadened in summary.`;
    const answer = await llmService.complete({ systemPrompt, userPrompt:request, temperature:0, maxTokens:180 });
    if (!answer.ok) return answer;
    try {
      const value = JSON.parse(String(answer.text).match(/\{[\s\S]*\}/)?.[0] || '{}');
      return typeof value.query === 'string' ? { ok:true, query:value.query.trim(), summary:typeof value.summary === 'string' ? value.summary.trim() : '' } : { ok:false, error:'The local model did not return a Kubernetes query.' };
    } catch (_) { return { ok:false, error:'The local model returned an unreadable Kubernetes plan.' }; }
  }
  const words = text => new Set(String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []);
  const score = (requestWords, item) => [...requestWords].reduce((total, word) => total + (`${item.name} ${item.namespace}`.toLowerCase().includes(word) ? 1 : 0), 0);
  async function diagnose({ request, context, namespace, tools }) {
    const trace = [];
    const overview = await tools.overview(context, namespace);
    if (!overview.ok) return overview;
    trace.push({ tool:'list_resources', detail:`Inspected pods, deployments, and services in ${overview.namespace || 'all namespaces'}.` });
    const requestWords = words(request);
    const candidates = overview.resources.flatMap(resource => (resource.items || []).map(item => ({ ...item, kind:resource.kind })))
      .map(item => ({ ...item, score:score(requestWords, item) })).sort((left, right) => right.score - left.score);
    const target = candidates.find(item => item.score > 0);
    if (!target) {
      const namespaces = [...new Set(candidates.map(item => item.namespace).filter(Boolean))].slice(0, 8);
      return {
        ok:true,
        clarification:true,
        summary:namespaces.length ? `I could not identify a matching workload yet. I found resources in ${namespaces.join(', ')}. Which namespace, workload, or pod should I inspect?` : 'I found no pods, deployments, or services in this scope. Which context or namespace should I inspect?',
        trace,
        candidates:[],
        evidence:[]
      };
    }
    const detailResult = await tools.detail({ kind:target.kind, name:target.name, namespace:target.namespace, context:overview.context });
    if (!detailResult.ok) return { ...detailResult, trace };
    const detail = detailResult.detail;
    trace.push({ tool:'inspect_resource', detail:`Inspected ${detail.kind}/${detail.name} in ${detail.namespace || 'the cluster'}.` });
    const logPod = detail.kind === 'pods' ? detail : detail.relatedPods?.[0];
    let logs = '';
    if (logPod?.name && logPod?.namespace) {
      const logResult = await tools.logs({ pod:logPod.name, namespace:logPod.namespace, context:overview.context });
      if (logResult.ok) { logs = String(logResult.output || '').slice(-12_000); trace.push({ tool:'read_logs', detail:`Read the latest bounded log tail from ${logPod.name}.` }); }
    }
    const evidence = [
      `Target: ${detail.kind}/${detail.name} namespace=${detail.namespace || 'cluster'}`,
      ...detail.facts.map(([key, value]) => `${key}: ${value}`),
      ...(detail.conditions || []).map(item => `Condition ${item.type}: ${item.status}${item.reason ? ` (${item.reason})` : ''}${item.message ? ` — ${item.message}` : ''}`),
      ...(detail.containers || []).map(item => `Container ${item.name}: ${item.state}, ready=${item.ready}, restarts=${item.restarts}`),
      ...(logs ? [`Recent logs:\n${logs}`] : [])
    ];
    const configured = await llmService.configured();
    let summary = `Inspected ${detail.kind}/${detail.name}.`;
    if (configured.configured && ['ollama', 'lmstudio'].includes(configured.provider)) {
      const answer = await llmService.complete({ systemPrompt:'You are the Kubernetes plugin diagnosis summarizer. Use only the supplied evidence. State what is healthy, what looks wrong, and the next safe inspection step. Do not claim certainty beyond the evidence. Do not suggest write commands. Keep it under 180 words.', userPrompt:`Request: ${request}\n\nEvidence:\n${evidence.join('\n')}`, temperature:0, maxTokens:320 });
      if (answer.ok && answer.text) summary = String(answer.text).trim();
    }
    return { ok:true, target:{ kind:detail.kind, name:detail.name, namespace:detail.namespace }, summary, trace, evidence, logs };
  }
  return { ...manifest, plan, diagnose };
}

module.exports = { createKubernetesPlugin, manifest };
