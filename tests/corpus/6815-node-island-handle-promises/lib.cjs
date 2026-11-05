"use strict";
let pending;
exports.later = (v, ms) => new Promise((resolve) => setTimeout(() => resolve(v), ms));
exports.fails = async (m) => {
  await null;
  throw new RangeError(m);
};
exports.object = async () => ({ answer: 42 });
exports.keep = () => (pending = Promise.resolve("kept"));
exports.isKept = (p) => p === pending;
