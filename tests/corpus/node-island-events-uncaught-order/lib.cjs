"use strict";
const log = (s) => console.log(s);
const kept = new Map();
const make = (label) => {
  const fn = (e, origin) => log(`island ${label}: ${e.message} ${origin}`);
  kept.set(label, fn);
  return fn;
};
exports.on = (event, label) => process.on(event, make(label));
exports.once = (event, label) => process.once(event, make(label));
exports.prepend = (event, label) => process.prependListener(event, make(label));
exports.off = (event, label) => process.removeListener(event, kept.get(label));
exports.offValue = (event, fn) => process.off(event, fn);
exports.count = (event) => process.listenerCount(event);
exports.listed = (event) => process.listeners(event).length;
exports.throwSoon = (m) =>
  setTimeout(() => {
    throw new Error(m);
  }, 1);
