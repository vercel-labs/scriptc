"use strict";
exports.delayed = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
exports.failing = (ms, m) => new Promise((_, r) => setTimeout(() => r(new Error(m)), ms));
exports.now = (v) => Promise.resolve(v);
exports.failed = (m) => Promise.reject(new Error(m));
exports.all = (ps) => Promise.all(ps);
exports.race = (ps) => Promise.race(ps);
exports.settled = (ps) => Promise.allSettled(ps);
exports.any = (ps) => Promise.any(ps);
// Island code that handles a promise itself and hands it out as well.
exports.selfHandled = (ms, m, log) => {
  const p = exports.failing(ms, m);
  p.catch((e) => log(`island handled ${e.message}`));
  return p;
};
exports.swallow = (p, log) => p.catch((e) => log(`island swallowed ${e.message}`));
