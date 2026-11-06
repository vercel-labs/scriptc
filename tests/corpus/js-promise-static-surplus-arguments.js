// The Promise statics called through Function.prototype.call evaluate every
// argument of the call before the algorithm runs: the constructor and the
// iterable are read, and the arguments after them run in order, so their
// effects and their exceptions are observable. The algorithm itself reads only
// the constructor and the iterable. Every observation is Node's own ordering.
"use strict";

const log = [];

function C(executor) {
  log.push("construct");
  executor(function () {}, function () {});
}
C.resolve = function (value) {
  return {
    then: function (onFulfilled) {
      onFulfilled(value);
    },
  };
};

function note(label) {
  log.push(label);
  return label;
}

// 1. The surplus arguments run after the iterable and before the algorithm,
//    left to right.
Promise.all.call(C, [1, 2], note("first extra"), note("second extra"));
console.log("surplus arguments: " + log.join(" | "));

// 2. An argument that throws stops the call before the capability exists.
log.length = 0;
try {
  Promise.all.call(C, [1, 2], (function () {
    throw new Error("extra threw");
  })());
} catch (error) {
  log.push("caught " + error.message);
}
console.log("surplus throws: " + log.join(" | "));

// 3. A single shared helper covers the static and apply forms alike.
log.length = 0;
Promise.race.call(C, [7], note("race extra"));
console.log("race surplus: " + log.join(" | "));
