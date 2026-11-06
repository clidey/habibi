import { loadUx } from '../../ux/ux-loader.js';
import { fileRequest, approve } from './api.js';
export async function addFileTask({ messages, request, grants, task, notify }) {
  const ux = await loadUx();
  const host = document.createElement('div');
  host.className = 'assistant-task-host';
  messages.append(host);
  const model = { request, grants, task, busy: false, result: null, error: '' };
  const mounted = ux.mountAssistantFileCard(host, model, async (action, value = {}) => {
    if (model.busy) return;
    model.busy = true;
    model.error = '';
    mounted.update({ ...model });
    try {
      if (action === 'prepare') {
        model.request = value.request || model.request;
        model.result = await fileRequest('prepare', {
          ...value,
          grants: grants.map((grant) => grant.id),
          request: model.request,
        });
        model.task = value.task;
      }
      if (action === 'preview') {
        const payload = { planId: model.result.plan.id, selected: value.selected };
        const approvalToken = await approve('file-tools.preview', payload);
        const result = await fileRequest('preview', { ...payload, approvalToken });
        model.result.previews = result.previews;
      }
      if (action === 'apply') {
        const payload = {
          planId: model.result.plan.id,
          selected: value.selected,
          cleanupAcknowledged: value.cleanupAcknowledged === true,
        };
        const approvalToken = await approve('file-tools.apply', payload);
        const result = await fileRequest('apply', { ...payload, approvalToken });
        model.result.previews = result.previews || model.result.previews;
        model.result.plan = { ...model.result.plan, status: 'applied', outputs: result.outputs };
      }
      if (action === 'undo') {
        const payload = { planId: model.result.plan.id };
        const approvalToken = await approve('file-tools.undo', payload);
        await fileRequest('undo', { ...payload, approvalToken });
        model.result.plan = { ...model.result.plan, status: 'undone', outputs: [] };
      }
      if (action === 'revise') model.result = null;
      if (action === 'open') {
        const result = await fetch('/api/open-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: value.path }),
        }).then((response) => response.json());
        if (!result.ok) throw new Error('This output could not be opened.');
      }
    } catch (error) {
      model.error = error.message;
      notify(error.message);
    } finally {
      model.busy = false;
      if (host.isConnected) mounted.update({ ...model });
    }
  });
  messages.scrollTop = messages.scrollHeight;
}
