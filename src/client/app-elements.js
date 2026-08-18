export function getAppElements() {
  return {
    input: document.querySelector('#command-input'),
    defaultView: document.querySelector('#default-view'),
    resultsView: document.querySelector('#results-view'),
    count: document.querySelector('#result-count'),
    updateButton: document.querySelector('#update-available'),
    toast: document.querySelector('#toast'),
    dropDock: document.querySelector('#drop-dock'),
  };
}
