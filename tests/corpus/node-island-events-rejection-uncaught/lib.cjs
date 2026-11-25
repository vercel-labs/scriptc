"use strict";
exports.listen = () =>
  process.on("uncaughtException", (e, origin) => console.log(`island listener: ${e.code ?? e.name} ${e.message} ${origin}`));
exports.rejectNow = (m) => {
  Promise.reject(new Error(m));
};
