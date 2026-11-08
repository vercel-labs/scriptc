"use strict";
const log = (s) => console.log(s);
const kept = new Map();
exports.listen = (label) => {
  const fn = (w) => log(`island ${label}: ${w.name}: ${w.message} ${w instanceof Error} code=${w.code} detail=${w.detail}`);
  kept.set(label, fn);
  process.on("warning", fn);
};
exports.unlisten = (label) => process.off("warning", kept.get(label));
exports.count = () => process.listenerCount("warning");
exports.call = (fn) => fn();
exports.emit = (m, name) => process.emitWarning(m, name);
