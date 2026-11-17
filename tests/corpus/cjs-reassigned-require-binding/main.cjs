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

// A rebound declaration beside ordinary declarators still gives its siblings
// their module globals: a function reading one must see its value.
var scaled = require("./whole.cjs"), factor = 3, tag = "scaled";
function describe(value) {
  return tag + ":" + scaled(value) * factor;
}
console.log(describe(4));
scaled = function (value) { return value + 1; };
console.log(describe(4));

// typeof reads the binding's current value, and a builtin module's boxed
// value answers the members it serves.
var pathModule = require("node:path"), base = "corpus";
function label(name) {
  return base + ":" + pathModule.basename(name);
}
console.log(typeof pathModule.join, label("/a/b.txt"));
pathModule = { join: function () { return "joined"; } };
console.log(typeof pathModule.join, typeof pathModule.sep, pathModule.join());

// A call through a reassigned binding answers the replacement's value: the
// checker's type for the original module must not leak into declarations,
// returns, or typeof of a member the box does not serve.
var fsModule = require("node:fs");
console.log(typeof fsModule.readFileSync);
fsModule = { readFileSync: function (p) { return "read " + p; } };
function readVia() {
  return fsModule.readFileSync("/corpus");
}
var readHeld = fsModule.readFileSync("/held");
console.log(readVia(), typeof readHeld, readHeld, typeof fsModule.statSync);
