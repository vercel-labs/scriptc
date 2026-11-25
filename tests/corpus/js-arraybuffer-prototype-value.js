// ArrayBuffer.prototype read as a value in JavaScript: the prototype object
// its views inherit from — the methods and the byteLength, maxByteLength,
// resizable and detached getters, in Node's own-property order — with the
// constructor link in both directions, and the TypeError a getter or method
// throws when it runs on the prototype object itself.
'use strict';

const prototype = ArrayBuffer.prototype;
const own = [
  "constructor",
  "byteLength",
  "slice",
  "maxByteLength",
  "resizable",
  "resize",
  "transfer",
  "transferToFixedLength",
  "detached",
];
console.log(
  "own",
  own.filter((name) => prototype.hasOwnProperty(name)).length,
  "of",
  own.length,
);
console.log("names", Object.getOwnPropertyNames(prototype).join(","));
console.log("identity", prototype === ArrayBuffer.prototype);
console.log("constructor", prototype.constructor === ArrayBuffer);

// The methods are the functions the views' member reads answer, and the
// getters are accessor properties named as Node names them.
console.log("slice", typeof prototype.slice, prototype.slice.length);
console.log("resize", typeof prototype.resize, prototype.resize.length);
console.log("transfer", typeof prototype.transfer, prototype.transfer.length);
const detached = Object.getOwnPropertyDescriptor(prototype, "detached");
console.log("detached", typeof detached.get, detached.set, detached.enumerable);
console.log("detachedName", detached.get.name);

// A view answers its own members through the prototype.
const buffer = new ArrayBuffer(8, { maxByteLength: 16 });
console.log(
  buffer.byteLength,
  buffer.maxByteLength,
  buffer.resizable,
  buffer.detached,
);

// A prototype getter run on a real ArrayBuffer answers its member; a
// SharedArrayBuffer, which has a prototype of its own, and any other value
// throw the TypeError an incompatible receiver throws.
const getterOf = (name) => Object.getOwnPropertyDescriptor(prototype, name).get;
const invoke = (fn, receiver) => fn.call(receiver);
const getters = ["byteLength", "maxByteLength", "resizable", "detached"];
console.log(
  "getters",
  getters.map((name) => String(invoke(getterOf(name), buffer))).join(","),
);
const shared = new SharedArrayBuffer(8);
for (const name of getters) {
  try {
    invoke(getterOf(name), shared);
    console.log(name, "no-throw");
  } catch (error) {
    console.log(name, error instanceof TypeError);
  }
}

// The methods brand-check the receiver the same way.
const copy = invoke(prototype.slice, buffer);
console.log("slice copy", copy.byteLength, copy.constructor === ArrayBuffer);
for (const method of ["slice", "resize"]) {
  try {
    invoke(prototype[method], shared);
    console.log("method", method, "no-throw");
  } catch (error) {
    console.log("method", method, error instanceof TypeError);
  }
}

// On the prototype object itself the getters and methods throw TypeError.
function report(name, call) {
  try {
    call();
    console.log(name, "no-throw");
  } catch (error) {
    console.log(name, error instanceof TypeError);
  }
}
report("detached", () => prototype.detached);
report("byteLength", () => prototype.byteLength);
report("slice", () => prototype.slice());

console.log("instanceof", prototype instanceof ArrayBuffer, buffer instanceof ArrayBuffer);
