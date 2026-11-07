"use strict";
// Object.isExtensible, Object.isSealed and Object.isFrozen answer from the
// integrity state the runtime models: plain objects, arrays, functions, Maps
// and Sets. A native handle or a promise refuses instead (scriptc does not
// track its integrity state, and answering there used to be silently
// wrong); tests/harness/handle-integrity-queries.test.ts pins the refusals.
function show(label, value) {
  console.log(label, Object.isExtensible(value), Object.isSealed(value), Object.isFrozen(value));
}
function fn() {}
const object = { a: 1 };
const array = [1, 2];
const map = new Map([["k", 1]]);
const set = new Set([1]);
show("object", object);
show("array", array);
show("function", fn);
show("map", map);
show("set", set);
show("frozen-object", Object.freeze({ b: 2 }));
show("frozen-array", Object.freeze([3]));
const sealed = { c: 3 };
Object.seal(sealed);
show("sealed-object", sealed);
const bare = {};
Object.preventExtensions(bare);
show("nonextensible", bare);
Object.preventExtensions(map);
show("nonextensible-map", map);
const frozen = { d: 4 };
Object.freeze(frozen);
show("frozen", frozen);
console.log([object, array, fn, map, set].map((value) => Object.isFrozen(value)).join(","));
