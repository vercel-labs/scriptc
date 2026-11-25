"use strict";

const order = [];

// Island listeners record their own order and the state they saw, on the
// island's signal and through a callback of the program.
exports.listen = (signal, label, nativeState) => {
  signal.addEventListener("abort", () => {
    order.push(`${label}:${signal.aborted}:${String(signal.reason)}:${nativeState()}`);
  });
};
exports.order = () => order.join(" ");
exports.state = (signal) => `${signal.aborted}:${String(signal.reason)}`;
