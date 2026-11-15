"use strict";
exports.install = () =>
  process.on("uncaughtException", (e, origin) => {
    const what = e instanceof Error ? `${e.name}: ${e.message}` : typeof e === "object" ? `object ${e.code}` : `${typeof e} ${e}`;
    console.log(`island: ${what} ${origin}`);
  });
exports.throwSoon = (m, code, status) =>
  setTimeout(() => {
    throw Object.assign(new TypeError(m), { code, status });
  }, 1);
