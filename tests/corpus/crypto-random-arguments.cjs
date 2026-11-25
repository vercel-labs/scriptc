// randomBytes and randomInt called with the shapes Node's overloads do not
// describe: sizes and bounds of every kind, missing and surplus arguments,
// callbacks that are not functions, an explicit undefined callback, and the
// asynchronous forms' argument checks. The drawn values are random, so only
// what is deterministic about them is printed.
"use strict";
const crypto = require("node:crypto");

function shape(value) {
  if (Buffer.isBuffer(value)) return `buffer ${value.length}`;
  if (typeof value === "number") return `number ${typeof value}`;
  return String(value);
}

function attempt(label, run) {
  try {
    console.log(label, "| ok", shape(run()));
  } catch (error) {
    console.log(label, "| error", error.name, error.code ?? "-", error.message);
  }
}

// Sizes: any number passes the type check, and the range check names the
// value; other kinds fail the type check before the callback is read.
for (const [label, size] of [
  ["four", 4],
  ["zero", 0],
  ["negative", -1],
  ["fraction", 2.5],
  ["negative fraction", -0.5],
  ["nan", NaN],
  ["infinity", Infinity],
  ["above the limit", 4294967296],
  ["string", "4"],
  ["null", null],
  ["undefined", undefined],
  ["bigint", 5n],
  ["boolean", true],
  ["object", {}],
]) {
  attempt(`bytes ${label}`, () => crypto.randomBytes(size));
}
attempt("bytes missing", () => crypto.randomBytes());

// The callback position: undefined selects the synchronous result, a value
// that is not a function is the callback error, and a surplus argument is
// ignored after it evaluates.
attempt("bytes undefined callback", () => crypto.randomBytes(4, undefined));
attempt("bytes number callback", () => crypto.randomBytes(4, 5));
attempt("bytes null callback", () => crypto.randomBytes(4, null));
attempt("bytes string callback", () => crypto.randomBytes(4, "x"));
attempt("bytes bad size and callback", () => crypto.randomBytes("x", "y"));
attempt("bytes negative size and callback", () => crypto.randomBytes(-1, "y"));
attempt("bytes surplus", () => crypto.randomBytes(2, undefined, "ignored"));
attempt("bytes four arguments", () => crypto.randomBytes(2, undefined, undefined, undefined));
const effects = [];
attempt("bytes surplus evaluates first", () =>
  crypto.randomBytes(2, undefined, effects.push("surplus")),
);
console.log("effects", effects.join());

// Bounds: a safe integer only, checked min before max, then the range.
attempt("int ten", () => crypto.randomInt(10));
attempt("int five to ten", () => crypto.randomInt(5, 10));
attempt("int zero", () => crypto.randomInt(0));
attempt("int negative", () => crypto.randomInt(-1));
attempt("int equal", () => crypto.randomInt(1, 1));
attempt("int reversed", () => crypto.randomInt(5, 2));
attempt("int string max", () => crypto.randomInt("10"));
attempt("int string min", () => crypto.randomInt("5", 10));
attempt("int fraction min", () => crypto.randomInt(1.5, 10));
attempt("int fraction max", () => crypto.randomInt(1, 1.5));
attempt("int nan max", () => crypto.randomInt(NaN));
attempt("int infinity max", () => crypto.randomInt(Infinity));
attempt("int bigint max", () => crypto.randomInt(5n));
attempt("int null max", () => crypto.randomInt(null));
attempt("int object min", () => crypto.randomInt({}, 10));
attempt("int negative min", () => crypto.randomInt(-5, 5));
attempt("int missing", () => crypto.randomInt());
attempt("int undefined max", () => crypto.randomInt(undefined));

// The callback position of the three-argument form is checked before the
// numbers; undefined there selects the synchronous result, and the
// two-argument form reads a function as the callback.
// The Node typings declare a three-argument randomInt as the callback form
// and no overload takes an explicit undefined there, so a value that leaves
// the call's own statement would be typed `never`; only its direct result
// is printed.
const undefinedCallback = crypto.randomInt(2, 10, undefined);
console.log("int undefined callback | ok", shape(undefinedCallback));
attempt("int null callback", () => crypto.randomInt(2, 10, null));
attempt("int string callback", () => crypto.randomInt(2, 10, "y"));
attempt("int boolean callback", () => crypto.randomInt(2, 10, true));
attempt("int bad bounds and callback", () => crypto.randomInt(5, 2, "y"));
// An explicit undefined result keeps its number where it is used directly;
// a program that returns it from a function declared void by the Node
// typings is a separate, deferred gap.
const fourArguments = crypto.randomInt(2, 10, undefined, 1);
console.log("int four arguments | ok", shape(fourArguments));
const undefinedSecond = crypto.randomInt(10, undefined);
console.log("int undefined second | ok", shape(undefinedSecond));

// The asynchronous forms: every callback arrives in a later macrotask with
// (null, value), a three-parameter callback receives undefined for the
// third, and the argument errors above throw synchronously instead. The
// callbacks of independent requests may complete in any order, so only the
// set of results is printed, after all of them ran.
const order = [];
let pending = 4;
let synchronous = true;
function done(label) {
  order.push(label);
  if (--pending === 0) {
    console.log("async order", order[0], "|", order.slice(1).sort().join(" | "));
  }
}
crypto.randomBytes(4, (error, buffer, extra) => {
  done(`bytes ${error} ${Buffer.isBuffer(buffer)} ${buffer.length} ${extra} ${synchronous}`);
  crypto.randomInt(10, (intError, value) => {
    done(`int ${intError} ${typeof value} ${value >= 0 && value < 10}`);
    crypto.randomInt(2, 10, (rangeError, ranged, rangedExtra) => {
      done(`range ${rangeError} ${typeof ranged} ${ranged >= 2 && ranged < 10} ${rangedExtra}`);
    });
  });
});
crypto.randomBytes(3, (error, buffer) => {
  done(`second bytes ${error} ${buffer.length}`);
}, "surplus");
order.push("synchronous end");
synchronous = false;

// A callback that is not a function throws before the program continues.
try {
  crypto.randomInt(2, 10, "not a function");
} catch (error) {
  console.log("synchronous callback error", error.name, error.code);
}
