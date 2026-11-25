// A truthiness test of a call through a function property the program
// replaces. The checker types the member `void` from its first assignment,
// but Node's function object answers whatever its body returns, so the test
// reads that value; a call nobody tests still runs once and discards it.
'use strict';

function noop() {}

var Internals = { d: { f: noop } };

function warnIfRendering(label) {
  if (Internals.d.f()) console.log(label + ": rendering");
}

warnIfRendering("initial");

Internals.d.f = function () {
  return true;
};
warnIfRendering("replaced");
console.log("value:", typeof Internals.d.f(), Internals.d.f());

Internals.d.f = function () {
  return 0;
};
warnIfRendering("zero");

Internals.d.f = function () {
  return "text";
};
warnIfRendering("text");

Internals.d = {
  flag: 1,
  f: function () {
    return this.flag;
  },
};
warnIfRendering("this");

var count = 0;
Internals.d.f = function () {
  count += 1;
  return count;
};
Internals.d.f();
console.log("ran:", count);

// The statement position keeps the value: `a && b` answers `a` when falsy.
Internals.d.f = function () {
  return "kept";
};
console.log(Internals.d.f() && "and-called");
Internals.d.f = function () {
  return 0;
};
console.log(Internals.d.f() && "and-called");
