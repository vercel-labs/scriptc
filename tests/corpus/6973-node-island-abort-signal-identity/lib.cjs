"use strict";
const { getEventListeners } = require("node:events");

const seen = new Map();
const weak = new WeakMap();
const listeners = new Map();
let kept;

exports.remember = (signal, label) => {
  const before = seen.get(signal);
  seen.set(signal, label);
  weak.set(signal, label);
  return `${before} -> ${label} (${seen.size})`;
};

exports.recall = (signal) => `${seen.get(signal)} ${weak.get(signal)} ${seen.has(signal)}`;

exports.keep = (signal) => {
  const same = kept === signal;
  kept = signal;
  return same;
};
exports.kept = () => kept;
exports.back = (signal) => signal;
exports.wrap = (signal) => ({ signal, list: [signal, signal] });

// A listener added in one call and removed in a later one: the island must
// see the same signal both times for the removal to find it.
exports.listen = (signal, label) => {
  const listener = () => console.log("listener", label);
  listeners.set(label, listener);
  signal.addEventListener("abort", listener);
  return getEventListeners(signal, "abort").length;
};
exports.unlisten = (signal, label) => {
  signal.removeEventListener("abort", listeners.get(label));
  return getEventListeners(signal, "abort").length;
};

exports.fromOptions = (options) => options.signal === kept;
