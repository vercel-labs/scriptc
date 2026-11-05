"use strict";
// The island half of gc-held.mjs (node-island-gc.test.ts): keeps every
// native callback it receives.
const kept = [];
function keep(cb) {
  kept.push(cb);
}
function callKept() {
  let s = 0;
  for (const cb of kept) s += cb();
  return s;
}
module.exports = { keep, callKept };
