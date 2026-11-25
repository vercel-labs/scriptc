"use strict";
exports.syncThrower = () => { throw new Error("island sync throw"); };
exports.rejecter = () => Promise.reject(new Error("island rejection"));
exports.asyncThrower = async () => { throw new Error("island async throw"); };
// How the island sees a native function fail: synchronously or by a promise.
exports.probe = (fn) => {
  let r;
  try {
    r = fn();
  } catch (e) {
    return `threw synchronously: ${e.message}`;
  }
  if (r instanceof Promise) {
    return r.then((v) => `fulfilled: ${v}`, (e) => `rejected: ${e.message}`);
  }
  return `returned ${typeof r}`;
};
exports.finallyOrder = async (fn, log) => {
  try {
    return await fn();
  } catch (e) {
    log(`island catch ${e.message}`);
    throw e;
  } finally {
    log("island finally");
  }
};
