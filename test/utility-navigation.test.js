const test = require('node:test');
const assert = require('node:assert/strict');
const { createResultActions } = require('../src/client/features/routing/result-actions');

for (const [type, query] of [
  ['clipboard', 'Clip'],
  ['clipboard', 'Clipboard history'],
  ['reminders', 'Reminders'],
  ['focus', 'Start a 10 minute focus timer'],
  ['recents', 'Recent files'],
]) {
  test(`selecting ${query} opens the local ${type} workspace without chat`, async () => {
    const calls = [];
    const actions = createResultActions({
      input: { value: query },
      daily: { show: (name, source) => calls.push([name, source]) },
      intentRouter: { showAgentic: () => assert.fail('Utility navigation must not open chat') },
    });
    await actions.showAction(type);
    assert.deepEqual(calls, [[type, query]]);
  });
}
