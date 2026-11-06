import { loadUx } from '../../ux/ux-loader.js';
const titles = {
  open_url: 'Open this website?',
  browser_search: 'Open this search?',
  provider_chat: 'Open another assistant?',
  open_folder: 'Open this folder?',
  open_app: 'Open this app?',
  local_files: 'Search local files?',
  mail: 'Open this mail request?',
  whatsapp: 'Open this WhatsApp request?',
  calendar: 'Open this calendar request?',
  whodb: 'Run this WhoDB request?',
  kubernetes: 'Run this Kubernetes investigation?',
  system: 'Open this system action?',
};
export async function reviewChatAction({ messages, route, request, onConfirm }) {
  const ux = await loadUx();
  const host = document.createElement('div');
  messages.append(host);
  const detail =
    route.url ||
    route.folder ||
    route.app ||
    route.question ||
    route.query ||
    route.target ||
    route.name ||
    request;
  const model = {
    title: titles[route.action] || 'Run this requested action?',
    detail: String(detail),
    status: 'awaiting',
  };
  const mounted = ux.mountAssistantActionReview(host, model, async (action) => {
    // This latch is independent of React state and prevents double execution.
    if (model.status !== 'awaiting') return;
    if (action === 'cancel') {
      model.status = 'cancelled';
      mounted.update({ ...model });
      return;
    }
    if (action !== 'confirm') return;
    model.status = 'running';
    mounted.update({ ...model });
    try {
      await onConfirm();
      model.status = 'done';
    } catch (error) {
      model.status = 'failed';
      model.error = error.message || 'This action could not complete.';
    }
    if (host.isConnected) mounted.update({ ...model });
  });
  messages.scrollTop = messages.scrollHeight;
}
