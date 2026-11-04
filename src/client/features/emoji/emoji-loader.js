/** Keep the full picker out of the launcher startup bundle. */
export function createEmojiFeature(deps) {
  let pending;
  let feature;
  return {
    async show() {
      try {
        const modulePath = '/assets/emoji.bundle.js';
        pending ||= import(modulePath).then(module => {
          feature = module.createEmojiFeature(deps);
          return feature;
        });
        await (await pending).show();
      } catch {
        pending = null;
        deps.notify('Could not load Emoji. Try again.');
      }
    },
    filter(value) { feature?.filter(value); },
    handleKey(event) { return feature?.handleKey(event) || false; },
  };
}
