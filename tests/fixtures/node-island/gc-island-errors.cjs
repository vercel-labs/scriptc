"use strict";
// The island half of gc-island-errors.mjs (node-island-gc.test.ts): throws
// a new error on every call and keeps none.
exports.fail = (i) => {
  throw Object.assign(new RangeError("island " + i), { index: i, payload: "x".repeat(256) });
};
exports.maxRss = () => process.resourceUsage().maxRSS;
