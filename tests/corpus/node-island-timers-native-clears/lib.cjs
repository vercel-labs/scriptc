"use strict";
const log = (s) => console.log(s);
exports.timeout = (ms, label) => setTimeout(() => log(`island timeout ${label}`), ms);
exports.interval = (ms, fn) => setInterval(fn, ms);
exports.immediate = (label) => setImmediate(() => log(`island immediate ${label}`));
exports.fromModule = (ms, label) =>
  require("node:timers").setTimeout(() => log(`island timeout ${label}`), ms);
exports.destroyed = (t) => t._destroyed;
