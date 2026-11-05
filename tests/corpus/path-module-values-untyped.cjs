// node:path module objects and function values held by untyped code. A
// path family passed through an untyped function is Node's plain object:
// Object.keys, Object.entries and Object.assign list its members in Node's
// order, and own-property checks see them. A function read through it is
// the same value as the typed read (`ns.join === path.posix.join`), and a
// const or module-level binding of a path function (`const join =
// path.join`) whose only store is that function, passed to untyped code, is
// that value too, so it compares equal and validates its arguments with
// Node's errors.
"use strict";
const assert = require("assert");
const path = require("path");

function pass(value) {
  return value;
}

// One value per function, whichever way it is read.
const ns = pass(path.posix);
assert.strictEqual(ns.join, path.posix.join);
assert.strictEqual(ns.join, path.join);
assert.strictEqual(pass(path).win32.basename, path.win32.basename);
assert.strictEqual(ns.posix, ns);
console.log(ns.join === path.posix.join, ns.join.name, ns.basename.name, ns.basename.length);

// Reflection over the module objects.
function keys(o) {
  return Object.keys(o);
}
function assign(o) {
  return Object.assign({}, o);
}
console.log(keys(path.posix).join(","));
console.log(keys(path.win32).join(","));
console.log(keys(path).join(",") === keys(path.posix).join(","));
const copy = assign(path.posix);
console.log(typeof copy.join, copy.join === path.posix.join, copy.sep, copy.delimiter, copy.win32 === path.win32);
const spread = pass({ ...pass(path.win32) });
console.log(Object.keys(spread).length, spread.sep, spread.resolve === path.win32.resolve);
function strings(o) {
  return Object.entries(o).filter(([, value]) => typeof value === "string");
}
console.log(JSON.stringify(strings(path.posix)), JSON.stringify(strings(path.win32)));
function has(o, key) {
  return Object.prototype.hasOwnProperty.call(o, key);
}
console.log(has(path.posix, "join"), has(path.win32, "_makeLong"), has(path.posix, "nope"));
let members = 0;
for (const key in pass(path.posix)) if (typeof path.posix[key] === "function") members++;
console.log(members);

// Bindings of path functions passed to untyped code.
const join = path.join;
const basename = path.posix.basename;
let resolve = path.resolve;
function sameJoin(f) {
  return f === path.join;
}
function sameBasename(f) {
  return f === path.posix.basename;
}
function sameResolve(f) {
  return f === path.resolve;
}
function call(f) {
  return f("a", "b");
}
console.log(sameJoin(join), sameBasename(basename), sameResolve(resolve), call(join));
function local() {
  const dirname = path.dirname;
  return ((f) => f === path.dirname)(dirname);
}
console.log(local());
function code(f) {
  try {
    f(5);
    return "no throw";
  } catch (e) {
    return `${e.name} ${e.code}`;
  }
}
console.log(code(join), code(basename), code(resolve));
