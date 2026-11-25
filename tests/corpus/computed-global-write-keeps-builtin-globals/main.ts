// A computed global write (`globalThis[key] = value`) names no property at
// compile time, so the write census cannot say which name it creates. It
// must not move Node's built-in globals onto the program-owned table: a
// computed write cannot replace one (the runtime refuses such a write), so
// `typeof Infinity` still answers "number" and every built-in keeps its
// value, exactly as in Node.
const key = "appState";
(globalThis as any)[key] = "written";
console.log((globalThis as any)[key]);
console.log(typeof Infinity, typeof NaN, typeof undefined, typeof globalThis);
console.log(
  typeof Array,
  typeof Object,
  typeof Number,
  typeof String,
  typeof Promise,
  typeof Map,
  typeof Symbol,
);
console.log(typeof Infinity === "number", typeof NaN === "number");
console.log(typeof undefined === "undefined", typeof globalThis === "object");
console.log(Infinity, -Infinity, Number.isNaN(NaN), 1 / 0 === Infinity);
const nothing = undefined;
console.log(nothing === undefined, typeof nothing);
console.log(globalThis === globalThis);
