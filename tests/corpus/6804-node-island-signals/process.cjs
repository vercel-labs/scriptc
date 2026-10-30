// Process events from island code (scope-B NI-3).
const listeners = new Map();

function listener(label) {
  let fn = listeners.get(label);
  if (fn === undefined) {
    fn = (name, number) => console.log(`island ${label} ${name} ${typeof number}`);
    listeners.set(label, fn);
  }
  return fn;
}

exports.listen = (signal, label) => {
  process.on(signal, listener(label));
};

exports.listenOnce = (signal, label) => {
  process.once(signal, listener(label));
};

exports.unlisten = (signal, label) => {
  process.removeListener(signal, listener(label));
};
