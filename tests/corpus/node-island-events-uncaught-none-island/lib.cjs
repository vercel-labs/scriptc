"use strict";
exports.install = () => {
  process.on("exit", (code) => console.log(`island exit ${code} ${process.exitCode}`));
  process.on("uncaughtExceptionMonitor", (e, origin) => console.log(`island monitor: ${e.message} ${origin}`));
};
exports.throwSoon = (m) =>
  setTimeout(() => {
    throw new Error(m);
  }, 5);
