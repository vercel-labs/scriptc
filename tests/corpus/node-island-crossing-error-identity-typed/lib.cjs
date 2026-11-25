"use strict";
exports.run = (fn) => fn();
exports.runAsync = async (fn) => await fn();
exports.rethrow = (fn) => {
  try {
    fn();
  } catch (e) {
    throw e;
  }
};
exports.wrap = (fn) => {
  try {
    fn();
  } catch (e) {
    throw new Error("island wrapper", { cause: e });
  }
};
exports.read = (fn) => {
  try {
    fn();
    return "did not throw";
  } catch (e) {
    return `${e.name} ${e.message} ${e.status} ${e.cause && e.cause.message} ${e instanceof Error} ${e instanceof TypeError} ${Object.prototype.toString.call(e)} ${Object.keys(e).sort().join(",")}`;
  }
};
