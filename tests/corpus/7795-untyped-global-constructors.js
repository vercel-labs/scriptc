"use strict";
// Global constructors read as values in untyped code: instanceof tests,
// identity comparisons and constructor names, as zod's type sniffing uses
// them, answer as in Node for every global the lookup knows.

/** @param {unknown} data */
function kind(data) {
  if (typeof Map !== "undefined" && data instanceof Map) return "map";
  if (typeof Set !== "undefined" && data instanceof Set) return "set";
  if (typeof Date !== "undefined" && data instanceof Date) return "date";
  if (data instanceof TypeError) return "type-error";
  if (data instanceof RangeError) return "range-error";
  if (data instanceof Error) return "error";
  if (data instanceof Promise) return "promise";
  if (Array.isArray(data)) return "array";
  return typeof data;
}

const values = [new Map(), new Set([1]), new Date(0), new TypeError("t"), new RangeError("r"), new SyntaxError("s"), new Error("e"), Promise.resolve(1), [1], { a: 1 }, "s", 1, null];
for (const value of values) console.log(kind(value));

const ctors = [Map, Set, Date, Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError, Object, Promise, WeakMap, WeakSet, RegExp];
console.log(ctors.map((ctor) => ctor.name).join(","));
console.log(ctors.every((ctor, i) => ctors.indexOf(ctor) === i));
const again = [Map, Set, Date, Error, TypeError];
console.log(again.every((ctor, i) => ctor === ctors[i]));
/** @type {any} */
const err = new TypeError("x");
console.log(err.constructor === TypeError, err.constructor === Error, err instanceof Error);
