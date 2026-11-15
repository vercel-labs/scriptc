"use strict";
const log = (s) => console.log(s);
exports.queueAll = (tag) => {
  setImmediate(() => log(`${tag} immediate`));
  process.nextTick(() => log(`${tag} tick`));
  queueMicrotask(() => log(`${tag} microtask`));
  Promise.resolve().then(() => log(`${tag} then`));
};
exports.tick = (fn) => process.nextTick(fn);
exports.micro = (fn) => queueMicrotask(fn);
exports.timeout = (fn, ms) => setTimeout(fn, ms);
exports.immediate = (fn) => setImmediate(fn);
