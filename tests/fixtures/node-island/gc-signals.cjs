"use strict";
const v8 = require("node:v8");
const vm = require("node:vm");

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");
v8.setFlagsFromString("--no-expose-gc");

let requests = 0;
let aborts = 0;
const held = [];

// A request holds its signal for its duration, as a client library does.
exports.request = (options) => {
  const { signal } = { ...options };
  requests++;
  const onAbort = () => aborts++;
  signal.addEventListener("abort", onAbort);
  return () => signal.removeEventListener("abort", onAbort);
};
// A listener on a signal the island does not keep.
exports.forget = (signal) => signal.addEventListener("abort", () => aborts++);
exports.hold = (signal) => held.push(signal);
exports.counts = () => `${requests} ${aborts} ${held.filter((s) => s.aborted).length}/${held.length}`;
// A signal the island makes per request and hands to the program.
exports.own = () => new AbortController().signal;
// A full V8 collection, now.
exports.fullGc = () => gc();
