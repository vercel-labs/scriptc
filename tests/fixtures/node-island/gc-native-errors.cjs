"use strict";
// The island half of gc-native-errors.mjs (node-island-gc.test.ts): it
// receives program errors and keeps none of them.
exports.run = (fn) => fn();
exports.swallow = (fn, i) => {
  try {
    fn();
  } catch (e) {
    return e.index === i && e instanceof Error ? 1 : 0;
  }
  return 0;
};
exports.read = (e) => e.message.length;
exports.causeIndex = (outer) => outer.cause.index;
exports.maxRss = () => process.resourceUsage().maxRSS;
