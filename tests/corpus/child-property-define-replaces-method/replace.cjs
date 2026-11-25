"use strict";
// The call names no builtin: `define` holds Object.defineProperty, and the
// alias is the only evidence that the child it receives has `kill` replaced.
// The member is named by a variable, so the compiler cannot read the name off
// the call and must let every typed child call reach the definition's member.
const define = Object.defineProperty;
module.exports = function replaceKill(child) {
  const key = "kill";
  define(child, key, {
    value: function kill() {
      return "replaced";
    },
    configurable: true,
  });
  return "defined";
};
