"use strict";

let requests = 0;
let aborts = 0;
const live = new Set();

// One request per signal, as a client library holds it: a listener for the
// request's duration, removed when the request ends.
exports.request = (options) => {
  const { signal } = { ...options };
  requests++;
  const onAbort = () => aborts++;
  signal.addEventListener("abort", onAbort);
  return () => signal.removeEventListener("abort", onAbort);
};

// A listener the island never removes, on a signal the island does not keep.
exports.forget = (signal) => {
  signal.addEventListener("abort", () => aborts++);
};

exports.hold = (signal) => live.add(signal);
exports.counts = () => `${requests} requests, ${aborts} aborts, ${live.size} held`;
exports.heldAborted = () => [...live].filter((signal) => signal.aborted).length;
