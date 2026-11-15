"use strict";
const log = (s) => console.log(s);
exports.timeout = (ms, label) => setTimeout(() => log(`island timeout ${label}`), ms);
exports.interval = (ms, fn) => setInterval(fn, ms);
exports.immediate = (label) => setImmediate(() => log(`island immediate ${label}`));
exports.clearT = (t) => clearTimeout(t);
exports.clearI = (t) => clearInterval(t);
exports.clearImm = (i) => clearImmediate(i);
