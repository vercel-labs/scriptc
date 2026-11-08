"use strict";
const timers = require("node:timers");
const log = (s) => console.log(s);
exports.clearT = (t) => clearTimeout(t);
exports.clearI = (t) => clearInterval(t);
exports.clearImm = (i) => clearImmediate(i);
exports.moduleClearT = (t) => timers.clearTimeout(t);
exports.moduleClearI = (t) => timers.clearInterval(t);
exports.moduleClearImm = (i) => timers.clearImmediate(i);
exports.clearAsString = (t) => clearTimeout(String(t));
exports.clearAll = (list) => {
  for (const t of list) clearTimeout(t);
};
// The island's own timers keep Node's primitive ids: clearing one by its
// number clears it and nothing else.
exports.ownByNumber = () => {
  const t = setTimeout(() => log("NOT REACHED island timer cleared by its number"), 10);
  const id = +t;
  clearTimeout(id);
  const s = setTimeout(() => log("NOT REACHED island timer cleared by its string"), 10);
  clearTimeout(`${s[Symbol.toPrimitive]()}`);
  return typeof id;
};
exports.sameFunctions = () =>
  [
    clearTimeout === timers.clearTimeout,
    clearInterval === timers.clearInterval,
    clearImmediate === timers.clearImmediate,
    clearTimeout.name,
    clearInterval.name,
    clearImmediate.name,
    clearTimeout.length,
  ].join(" ");
