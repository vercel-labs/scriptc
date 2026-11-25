"use strict";
exports.install = (label) =>
  process.on("uncaughtException", (e) => console.log(`island ${label}: ${e.message}`));
exports.throwSoon = (m) =>
  setTimeout(() => {
    throw new Error(m);
  }, 5);
