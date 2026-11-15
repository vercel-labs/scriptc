"use strict";
const log = (s) => console.log(s);
exports.monitor = () =>
  process.on("uncaughtExceptionMonitor", (e, origin) => log(`island monitor: ${e.message} ${origin}`));
exports.capture = () => process.setUncaughtExceptionCaptureCallback((e) => log(`captured: ${e.message}`));
exports.release = () => process.setUncaughtExceptionCaptureCallback(null);
exports.capturing = () => process.hasUncaughtExceptionCaptureCallback();
exports.listen = () => process.on("uncaughtException", (e, origin) => log(`island listener: ${e.message} ${origin}`));
exports.throwSoon = (m) =>
  setTimeout(() => {
    throw new Error(m);
  }, 1);
exports.rejectNow = (m) => {
  Promise.reject(new Error(m));
};
