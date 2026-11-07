"use strict";
let kept;

// Signals and controllers the island makes.
exports.controller = () => new AbortController();
exports.aborted = (reason) => AbortSignal.abort(reason);
exports.timeout = (ms) => AbortSignal.timeout(ms);

// What the island still sees of a signal native code used.
exports.same = (controller, signal) => controller.signal === signal;
exports.keep = (signal) => {
  const same = kept === signal;
  kept = signal;
  return same;
};
exports.state = (signal) => `${signal instanceof AbortSignal} ${signal.aborted} ${String(signal.reason)}`;

// A client that makes its own controller per request and hands the signal
// to the program's transport, as provider SDKs do with a custom fetch.
exports.request = async (transport, url, cancelAfter) => {
  const controller = new AbortController();
  if (cancelAfter !== undefined) setTimeout(() => controller.abort(new Error("client cancelled")), cancelAfter);
  try {
    return `ok ${await transport(url, controller.signal)}`;
  } catch (error) {
    return `failed ${error.name}: ${error.message} (${controller.signal.aborted})`;
  }
};
