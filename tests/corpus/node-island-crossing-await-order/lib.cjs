"use strict";
exports.resolved = (v) => Promise.resolve(v);
exports.rejected = (m) => Promise.reject(new Error(m));
exports.later = (v) => new Promise((resolve) => setImmediate(() => resolve(v)));
// An island async function that awaits a native function's promise.
exports.through = async (fn, tag, log) => {
  log(`${tag} island before`);
  const v = await fn();
  log(`${tag} island after ${v}`);
  return v + 1;
};
exports.then = (p, f) => p.then(f);
