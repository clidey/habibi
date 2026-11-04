import { createAppearance } from './appearance.js';

/** The launcher needs appearance immediately; the preferences page loads on demand. */
export function createSettingsFeature(deps) {
  let pending; let feature; let generation = 0;
  return {
    ...createAppearance(),
    async show(options) {
      const token = ++generation;
      const path = '/assets/settings.bundle.js';
      try {
        pending ||= import(path).then(module => { feature = module.createSettingsFeature(deps); return feature; }).catch(error => { pending = null; throw error; });
        const loaded = await pending;
        if (token === generation) loaded.show(options);
      } catch { if (token === generation) deps.notify('Could not open Settings. Try again.'); }
    },
    close() { generation++; feature?.close(); },
  };
}
