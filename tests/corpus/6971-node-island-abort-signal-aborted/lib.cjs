"use strict";
const { EventEmitter, once } = require("node:events");

function show(reason) {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  if (typeof reason === "object" && reason !== null) return JSON.stringify(reason);
  return `${typeof reason} ${String(reason)}`;
}

exports.inspect = (label, signal) => {
  let thrown = "nothing";
  try {
    signal.throwIfAborted();
  } catch (error) {
    thrown = `${show(error)} same ${error === signal.reason}`;
  }
  // A listener added to an aborted signal never runs.
  let ran = false;
  signal.addEventListener("abort", () => (ran = true));
  console.log(label, signal instanceof AbortSignal, signal.aborted, show(signal.reason), "throws", thrown, "ran", ran);
};

// Receivers that reject at once for an aborted signal.
exports.receivers = async (signal) => {
  const outcomes = [];
  try {
    await once(new EventEmitter(), "never", { signal });
  } catch (error) {
    outcomes.push(`once ${error.name} ${error.code} ${error.cause === signal.reason}`);
  }
  const any = AbortSignal.any([new AbortController().signal, signal]);
  outcomes.push(`any ${any.aborted} ${any.reason === signal.reason}`);
  const target = new EventTarget();
  target.addEventListener("ping", () => outcomes.push("listener ran"), { signal });
  target.dispatchEvent(new Event("ping"));
  return outcomes.join("; ");
};

exports.selfReason = (signal) => `${signal.aborted} ${signal.reason === signal}`;
