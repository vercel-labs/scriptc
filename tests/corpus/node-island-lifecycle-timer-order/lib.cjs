"use strict";
const log = (s) => console.log(s);
exports.timeout = (ms, label) => setTimeout(() => log(`island ${label}`), ms);
exports.timeoutCb = (ms, fn) => setTimeout(fn, ms);
exports.interval = (ms, fn) => setInterval(fn, ms);
exports.args = (fn) => setTimeout(fn, 1, "a", 2, { k: 3 });
