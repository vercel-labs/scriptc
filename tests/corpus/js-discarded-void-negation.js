"use strict";

const calls = [];
function effect(value) {
  calls.push(value);
}

!effect("direct");
((!effect("parentheses")));
!!effect("double");
!!!effect("triple");
!function () {
  effect("iife");
}();

/** @returns {void} */
function claimedVoid() {
  effect("claimed");
  return true;
}
!claimedVoid();

const bag = {
  /** @returns {void} */
  get value() {
    effect("getter");
  },
};
!bag.value;
!(calls.length === 0 ? effect("wrong") : effect("conditional"));
!(effect("comma-first"), effect("comma-second"));

function mayThrow(value) {
  effect(value);
  if (value === "throw") throw new Error("stop");
}

try {
  !mayThrow("throw");
  effect("unreachable");
} catch (error) {
  console.log(error instanceof Error, error.message);
}

console.log(calls.join(","));
