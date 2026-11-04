/** Compose and attachment handling are loaded only when a draft is opened. */
export function createMailComposer(deps) {
  let pending;
  const path = '/assets/mail-composer.bundle.js';
  const modulePath = '/assets/mail-composer.bundle.js';
  return {
    async show(...args) {
      try {
        const composer = await (pending ||= import(modulePath).then((module) =>
          module.createMailComposer(deps),
        ));
        return composer.show(...args);
      } catch {
        pending = null;
        deps.notify('Could not open the mail composer. Try again.');
      }
    },
  };
}
