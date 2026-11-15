"use strict";
exports.never = () => new Promise(() => {});
exports.neverThenable = () => ({ then() {} });
exports.holds = [];
exports.hold = (v) => exports.holds.push(v);
exports.awaitNever = async (p, log) => {
  try {
    await p;
  } finally {
    log("NOT REACHED island finally");
  }
};
