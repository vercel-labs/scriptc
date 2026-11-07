"use strict";
exports.run = (fn) => fn();
exports.fail = (i) => {
  throw Object.assign(new RangeError("island " + i), { index: i });
};
