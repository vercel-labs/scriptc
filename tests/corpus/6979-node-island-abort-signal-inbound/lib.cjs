"use strict";
let kept;

// Signals and controllers the island makes.
exports.controller = () => new AbortController();
exports.aborted = (reason) => AbortSignal.abort(reason);
exports.timeout = (ms) => AbortSignal.timeout(ms);

// What the island still sees of a signal native code used.
exports.same = (controller, signal) => controller.signal === signal;
// One island signal in two arguments of one native call, before either
// argument has crossed; the signal aborts after the call.
exports.pair = (callback) => {
  const controller = new AbortController();
  const answer = callback(controller.signal, controller.signal);
  controller.abort("paired");
  return answer;
};
exports.keep = (signal) => {
  const same = kept === signal;
  kept = signal;
  return same;
};
// One signal in two arguments of a native callback, and again later.
exports.twice = (callback) => {
  const signal = new AbortController().signal;
  return `${callback(signal, signal)} ${callback(signal, signal)}`;
};
// Three arguments: a signal, an aborted one, and the first again.
exports.interleaved = (callback) => {
  const first = new AbortController().signal;
  return callback(first, AbortSignal.abort("mid"), first);
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
