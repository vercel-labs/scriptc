// A sloppy-mode function called with undefined or null as its receiver reads
// builtin globals on the global object by computed keys, directly and through
// a variable its `this` initializes.

function readByKey(key) {
  return this[key];
}
function aliasedRead(key) {
  var root = this;
  return root[key];
}

console.log(readByKey("Array") === Array, readByKey("JSON") === JSON);
console.log(aliasedRead("Map") === Map, typeof aliasedRead("setTimeout"));
console.log(readByKey.call(null, "Promise") === Promise, readByKey.call({ Promise: 1 }, "Promise"));
console.log(readByKey("globalThis") === globalThis, readByKey("missingGlobal"));

const names = ["Object", "Symbol", "Uint8Array"];
const values = [Object, Symbol, Uint8Array];
console.log(names.map((name, i) => readByKey(name) === values[i]));

function strictRead(key) {
  "use strict";
  return this === undefined ? "no receiver" : this[key];
}
console.log(strictRead("Array"), strictRead.call({ Array: 2 }, "Array"));
