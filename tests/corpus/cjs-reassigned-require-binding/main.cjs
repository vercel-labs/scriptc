// A CommonJS `var`/`let` holding require()'s result is an ordinary mutable
// binding: Node's assignment replaces the module's value, and later reads
// and calls see the replacement, while reads before it see what the module
// exported.
"use strict";

var double = require("./whole.cjs");
console.log(double(21));
double = function (value) { return value + 1; };
console.log(double(21), typeof double);

let also = require("./whole.cjs");
console.log(also(5));
also = function (value) { return value - 1; };
console.log(also(5), typeof also);

var held = require("./whole.cjs");
function callIt(value) {
  return held(value);
}
console.log(callIt(3));
held = function (value) { return value * 10; };
console.log(callIt(3));

// A module whose exports are one object literal supplies that object.
var shape = require("./object.cjs");
console.log(shape.version, shape.label);
shape = { version: 5, label: "replaced" };
console.log(shape.version, shape.label);

// A builtin require binding is the same mutable var: a method call after the
// reassignment reaches the stored function, not the builtin.
var fsLike = require("node:path");
console.log(typeof fsLike.join, fsLike.join("a", "b"));
fsLike = { join: function () { return "replaced"; } };
console.log(fsLike.join("a", "b"));
