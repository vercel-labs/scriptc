"use strict";
const log = (s) => console.log(s);
exports.install = () => {
  process.on("uncaughtException", (e, origin) => log(`island listener: ${e.message} ${origin}`));
  process.on("unhandledRejection", (r) => log(`island rejection: ${r.message}`));
  process.on("warning", (w) => log(`island warning: ${w.message}`));
};
exports.counts = () =>
  ["uncaughtException", "unhandledRejection", "warning"].map((event) => process.listenerCount(event)).join(" ");
