"use strict";
exports.failing = (ms, m) => new Promise((_, r) => setTimeout(() => r(new Error(m)), ms));
exports.selfHandled = (ms, m, log) => {
  const p = exports.failing(ms, m);
  p.catch((e) => log(`island handled ${e.message}`));
  return p;
};
