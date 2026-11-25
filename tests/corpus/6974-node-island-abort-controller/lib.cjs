"use strict";

function show(reason) {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  if (typeof reason === "object" && reason !== null) return JSON.stringify(reason);
  return `${typeof reason} ${String(reason)}`;
}

const signalGetter = Object.getOwnPropertyDescriptor(AbortController.prototype, "signal").get;
let keptController;
let keptReason;

exports.describe = (controller) =>
  [
    Object.prototype.toString.call(controller),
    controller instanceof AbortController,
    signalGetter.call(controller) === controller.signal,
    controller.signal instanceof AbortSignal,
    controller.signal === controller.signal,
    typeof controller.abort,
    controller.abort.name,
    controller.abort.length,
    Object.keys(controller).length,
  ].join(" ");

// The controller's signal is the signal the program hands over on its own.
exports.sameSignal = (controller, signal) => controller.signal === signal;

exports.keep = (controller) => {
  const same = keptController === controller;
  keptController = controller;
  controller.signal.addEventListener("abort", () =>
    console.log("island listener", controller.signal.aborted, show(controller.signal.reason)),
  );
  return same;
};

// Aborting from the island aborts the program's controller.
exports.abortKept = (...reason) => {
  keptController.abort(...reason);
  return `${keptController.signal.aborted} ${show(keptController.signal.reason)}`;
};

exports.abortWithObject = (controller) => {
  keptReason = { from: "island" };
  controller.abort(keptReason);
  return controller.signal.reason === keptReason;
};
exports.isKeptReason = (reason) => reason === keptReason;
exports.back = (controller) => controller;
exports.state = (signal) => `${signal.aborted} ${show(signal.reason)}`;
