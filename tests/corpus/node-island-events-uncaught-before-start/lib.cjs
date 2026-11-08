"use strict";
const log = (s) => console.log(s);
exports.install = () => {
  process.on("uncaughtExceptionMonitor", (e, origin) => log(`island monitor: ${e.message} ${origin}`));
  process.on("uncaughtException", (e, origin) => log(`island listener: ${e.message} ${origin}`));
  process.on("unhandledRejection", (r) => log(`island rejection: ${r.message}`));
  process.on("warning", (w) => log(`island warning: ${w.name}: ${w.message}`));
};
exports.counts = () =>
  ["uncaughtExceptionMonitor", "uncaughtException", "unhandledRejection", "warning"]
    .map((event) => process.listenerCount(event))
    .join(" ");
exports.throwSoon = (m) => {
  setTimeout(() => {
    throw new Error(m);
  }, 1);
};
exports.rejectNow = (m) => {
  Promise.reject(new Error(m));
};
exports.warn = (m) => process.emitWarning(m, "IslandWarning");
