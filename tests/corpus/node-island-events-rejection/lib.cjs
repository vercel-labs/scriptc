"use strict";
const log = (s) => console.log(s);
exports.listen = (label) =>
  process.on("unhandledRejection", (reason, promise) =>
    log(`island ${label}: ${reason.message} ${promise instanceof Promise}`),
  );
exports.listenCallback = (fn) => process.on("unhandledRejection", fn);
exports.count = () => process.listenerCount("unhandledRejection");
exports.rejectNow = (m) => {
  Promise.reject(new Error(m));
};
exports.rejected = (m) => Promise.reject(new Error(m));
exports.hold = (p) => {
  exports.held = p;
};
exports.swallow = (p) => {
  p.catch((e) => log(`island caught: ${e.message}`));
};
