"use strict";
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
