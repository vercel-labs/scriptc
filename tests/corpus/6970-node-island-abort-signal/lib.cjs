"use strict";
const { EventEmitter, once, addAbortListener, getEventListeners } = require("node:events");
const timersPromises = require("node:timers/promises");
const { aborted: abortedGetter } = Object.getOwnPropertyDescriptors(AbortSignal.prototype);

function show(reason) {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  if (typeof reason === "object" && reason !== null) return JSON.stringify(reason);
  return `${typeof reason} ${String(reason)}`;
}

// What island code that tests a signal's brand sees.
exports.describe = (signal) =>
  [
    Object.prototype.toString.call(signal),
    signal.constructor.name,
    signal instanceof AbortSignal,
    signal instanceof EventTarget,
    Object.getPrototypeOf(signal) === AbortSignal.prototype,
    abortedGetter.get.call(signal),
  ].join(" ");

exports.state = (signal) => `${signal.aborted} ${show(signal.reason)}`;

exports.watch = (label, signal) => {
  signal.addEventListener("abort", (event) => {
    console.log(label, "abort", event.type, event.target === signal, event.isTrusted, exports.state(signal));
  });
};

exports.throwIfAborted = (signal) => {
  try {
    signal.throwIfAborted();
    return "did not throw";
  } catch (error) {
    return `threw ${show(error)} same ${error === signal.reason}`;
  }
};

// The options object is copied, as request libraries copy theirs: the
// signal is read as a property of the program's record.
exports.request = (options) => {
  const { signal, ...rest } = { ...options };
  return new Promise((resolve, reject) => {
    if (signal === undefined) return resolve(`no signal ${JSON.stringify(rest)}`);
    signal.throwIfAborted();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
};

// Listener forms on the island's side.
exports.listeners = (signal) => {
  const log = [];
  const removed = () => log.push("removed");
  signal.addEventListener("abort", () => log.push("first"));
  signal.addEventListener("abort", removed);
  signal.addEventListener("abort", () => log.push("once"), { once: true });
  signal.onabort = () => log.push("onabort");
  signal.addEventListener("abort", { handleEvent: () => log.push("object") });
  signal.removeEventListener("abort", removed);
  const other = new AbortController();
  signal.addEventListener("abort", () => log.push("cancelled"), { signal: other.signal });
  other.abort();
  signal.addEventListener("abort", () => log.push(`last ${getEventListeners(signal, "abort").length}`));
  return () => log.join(",");
};

// Node's own receivers of a signal: each tests its brand.
exports.nodeApis = (signal) => {
  const outcome = (promise) =>
    promise.then(
      (value) => `resolved ${value}`,
      (error) => `${error.name} ${error.code} cause ${show(error.cause)} same ${error.cause === signal.reason}`,
    );
  const disposable = addAbortListener(signal, () => console.log("addAbortListener ran"));
  return {
    once: outcome(once(new EventEmitter(), "never", { signal })),
    sleep: outcome(timersPromises.setTimeout(60_000, "late", { signal })),
    any: AbortSignal.any([signal, new AbortController().signal]),
    disposable: typeof disposable[Symbol.dispose],
  };
};
