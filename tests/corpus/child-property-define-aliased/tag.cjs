"use strict";
// The call names no builtin: `define` holds Object.defineProperty, and the
// alias is the only evidence that this function defines a property on the
// child it receives.
const define = Object.defineProperty;
module.exports = function tag(child) {
  define(child, "stamped", { value: "stamped", configurable: true });
};
