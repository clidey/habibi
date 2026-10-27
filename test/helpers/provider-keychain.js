const { EventEmitter } = require('node:events');

// Exercise the actual process protocol with a memory-backed replacement for macOS Keychain.
function providerKeychain(calls = [], initialKey = 'stored-api-key') {
  const saved = new Map();
  return (program, args) => {
    calls.push([program, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const account = program === 'security' ? args[args.indexOf('-a') + 1] : args[1];
    child.stdin = { end: (value) => {
      saved.set(account, value);
      queueMicrotask(() => child.emit('close', 0));
    } };
    if (program === 'security' || args[0] === 'get-model-key') queueMicrotask(() => {
      child.stdout.emit('data', saved.get(account) || initialKey);
      child.emit('close', 0);
    });
    return child;
  };
}
module.exports = { providerKeychain };
