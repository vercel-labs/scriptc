"use strict";
// An array whose length Object.defineProperty made non-writable cannot grow:
// a write to an index at or past the length is a write of the length, and
// throws the read-only TypeError whether the index is a number literal, a
// computed key or a string. A write inside the length still lands.
/** @param {any} value */
function dyn(value) {
  return value;
}
const a = dyn([1, 2]);
Object.defineProperty(a, "length", { writable: false });
function attempt(label, run) {
  try {
    run();
    console.log(label, "ok", a.length, a[2]);
  } catch (e) {
    console.log(label, e.constructor.name, e.message, a.length);
  }
}
attempt("index", () => {
  a[2] = 3;
});
attempt("far", () => {
  a[10] = 3;
});
attempt("push", () => {
  a.push(3);
});
attempt("in-range", () => {
  a[1] = 9;
});
const key = dyn(2);
attempt("computed", () => {
  a[key] = 3;
});
attempt("string-key", () => {
  a["2"] = 3;
});
console.log(a.length, JSON.stringify(a), Object.keys(a).join(","));

// A writable length grows as before.
const b = dyn([1, 2]);
b[3] = 4;
console.log(b.length, JSON.stringify(b));
