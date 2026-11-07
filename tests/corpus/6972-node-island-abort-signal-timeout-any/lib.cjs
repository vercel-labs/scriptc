"use strict";

function show(reason) {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return `${typeof reason} ${String(reason)}`;
}

// Resolves with what the signal's abort looked like from the island.
exports.whenAborted = (label, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(`${label} already ${show(signal.reason)}`);
    signal.addEventListener("abort", () => resolve(`${label} aborted ${show(signal.reason)}`), {
      once: true,
    });
  });

exports.isSignal = (signal) => signal instanceof AbortSignal && !signal.aborted;

// A signal made on the island, and the controller that aborts it.
exports.makeController = () => new AbortController();

// Combined on the island: the island's AbortSignal.any over a native signal
// and an island one.
exports.combine = (nativeSignal, islandSignal) => AbortSignal.any([nativeSignal, islandSignal]);
