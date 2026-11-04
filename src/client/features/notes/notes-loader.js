/** Load Markdown and Notes only when requested, keeping launcher startup small. */
export function createNotesFeature(deps) {
  let pending; let feature;
  async function load() {
    const path = '/assets/notes.bundle.js';
    pending ||= import(path).then(module => { feature = module.createNotesFeature(deps); return feature; }).catch(error => { pending = null; throw error; });
    return pending;
  }
  return {
    async show(options) { try { await (await load()).show(options); } catch { deps.notify('Could not load Notes. Try again.'); } },
    async capture(source) { try { await (await load()).capture(source); } catch { deps.notify('Could not open Notes. Try again.'); } },
    filter(value) { feature?.filter(value); },
    handleKey(event) { return feature?.handleKey(event) || false; },
  };
}
