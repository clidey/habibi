let assetPromise;

/** Load published Clidey UX once, when a workspace first needs it. */
export function loadUx() {
  if (window.HabibiUx) return Promise.resolve(window.HabibiUx);
  if (assetPromise) return assetPromise;
  assetPromise = new Promise((resolve, reject) => {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/assets/styles/ux.css';
    const appStylesheet = document.head.querySelector('link[href="app.css"]');
    const script = document.createElement('script');
    script.src = '/assets/ux.bundle.js';
    let stylesReady = false;
    let scriptReady = false;
    function ready() {
      if (stylesReady && scriptReady) resolve(window.HabibiUx);
    }
    function failed() {
      assetPromise = undefined;
      script.remove();
      stylesheet.remove();
      reject(new Error('Could not load Clidey UX'));
    }
    stylesheet.onload = () => { stylesReady = true; ready(); };
    stylesheet.onerror = failed;
    script.onload = () => { scriptReady = true; ready(); };
    script.onerror = failed;
    document.head.insertBefore(stylesheet, appStylesheet);
    document.head.append(script);
  });
  return assetPromise;
}
