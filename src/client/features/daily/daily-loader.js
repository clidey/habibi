/** Utility content and native data are loaded only when opened. */
export function createDailyFeature(deps) {
  let pending;
  let feature;
  const modulePath = '/assets/daily.bundle.js';
  const path = '/assets/daily.bundle.js';
  const load = () =>
    (pending ||= import(path)
      .then((module) => {
        feature = module.createDailyFeature(deps);
        return feature;
      })
      .catch((error) => {
        pending = null;
        throw error;
      }));
  return {
    show: (name, query) =>
      load()
        .then((value) => value.show(name, query))
        .catch(() => deps.notify('Could not open this utility. Try again.')),
    filter: (query) => feature?.filter(query),
  };
}
