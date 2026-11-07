"use strict";
// The call names no builtin: `define` holds Object.defineProperty, and the
// alias is the only evidence that the child it receives has `kill` replaced.
const define = Object.defineProperty;
module.exports = function replaceKill(child) {
  define(child, "kill", {
    value: function kill() {
      return "replaced";
    },
    configurable: true,
  });
  return "defined";
};
