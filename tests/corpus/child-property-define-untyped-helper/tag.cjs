"use strict";
// `child` is an untyped parameter: the checker resolves no type for it, so
// this definition is the only evidence that a child receives properties here.
module.exports = function tag(child) {
  Object.defineProperty(child, "label", { value: "tagged", configurable: true });
};
