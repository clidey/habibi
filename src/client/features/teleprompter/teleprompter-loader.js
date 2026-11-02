/** Keep the script editor out of the launcher's startup bundle. */
export function createTeleprompterFeature(deps) {
  let pending;
  return {
    async show() {
      try {
        const modulePath = '/assets/teleprompter.bundle.js';
        pending ||= import(modulePath).then(module => module.createTeleprompterFeature(deps));
        (await pending).show();
      } catch {
        pending = null;
        deps.notify('Could not load Teleprompter. Try again.');
      }
    },
  };
}
