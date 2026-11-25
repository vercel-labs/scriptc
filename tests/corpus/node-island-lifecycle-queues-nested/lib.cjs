"use strict";
const log = (s) => console.log(s);
exports.queueAll = (tag) => {
  setImmediate(() => log(`${tag} immediate`));
  process.nextTick(() => log(`${tag} tick`));
  queueMicrotask(() => log(`${tag} microtask`));
};
// tick -> microtask -> tick chains, the callbacks alternating sides.
exports.chain = (tag, depth, native) => {
  if (depth === 0) return;
  process.nextTick(() => {
    log(`${tag} tick ${depth}`);
    queueMicrotask(() => {
      log(`${tag} micro ${depth}`);
      native(tag, depth - 1);
    });
  });
};
exports.inTimer = (fn) => setTimeout(fn, 1);
exports.inImmediate = (fn) => setImmediate(fn);
