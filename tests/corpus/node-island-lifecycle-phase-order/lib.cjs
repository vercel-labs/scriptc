"use strict";
const log = (s) => console.log(s);
exports.queue = (tag) => {
  setTimeout(() => log(`${tag} timeout`), 0);
  setImmediate(() => log(`${tag} immediate`));
  process.nextTick(() => log(`${tag} tick`));
  queueMicrotask(() => log(`${tag} microtask`));
};
exports.inTimer = (fn) => setTimeout(fn, 1);
exports.inFs = (fn) => require("node:fs").stat(__filename, fn);
