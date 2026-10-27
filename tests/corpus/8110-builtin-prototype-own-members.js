"use strict";
// Own members of the builtin prototypes and the constructor links that
// reach them, read in untyped code: Object.prototype has its own
// isPrototypeOf, hasOwnProperty and constructor; a plain object's
// constructor is Object, whose prototype is Object.prototype; an array's
// constructor is Array, whose prototype owns its methods and constructor.

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const objectKeys = ["constructor", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toString", "toLocaleString", "valueOf", "__proto__", "__defineGetter__", "__lookupSetter__", "missing", "length"];
for (const key of objectKeys) console.log("Object.prototype", key, has(Object.prototype, key), Object.hasOwn(Object.prototype, key));
console.log(Object.getOwnPropertyNames(Object.prototype).join(","));
console.log(Object.prototype.hasOwnProperty("isPrototypeOf"), Object.prototype.hasOwnProperty("nope"));

const arrayKeys = ["constructor", "push", "map", "length", "at", "hasOwnProperty", "isPrototypeOf", "missing"];
for (const key of arrayKeys) console.log("Array.prototype", key, has(Array.prototype, key));
const arrayNames = Object.getOwnPropertyNames(Array.prototype);
console.log(arrayNames.length, arrayNames.includes("constructor"), arrayNames.includes("length"), arrayNames.includes("hasOwnProperty"));

/** @param {any} value */
function links(label, value) {
  const ctor = value.constructor;
  const prototype = ctor.prototype;
  console.log(label, typeof ctor, ctor.name, typeof prototype, prototype === Object.getPrototypeOf(value), has(prototype, "constructor"), has(prototype, "isPrototypeOf"));
}
links("object", {});
links("object-with-keys", { a: 1, b: [2] });
links("parsed", JSON.parse('{"x":{"y":1}}'));
links("nested", JSON.parse('{"x":{"y":1}}').x);
links("array", []);
links("array-of", [1, 2, 3]);
const error = new Error("boom");
console.log("error", typeof error.constructor, error.constructor.name, error.constructor.prototype === Error.prototype, has(error.constructor.prototype, "isPrototypeOf"));

/** @param {any} value */
const ctorOf = (value) => value.constructor;
console.log(ctorOf({}) === Object, ctorOf({}).prototype === Object.prototype, ctorOf([]) === Array, ctorOf([]).prototype === Array.prototype);
console.log(Object.prototype.constructor === Object, Object.prototype.constructor.prototype === Object.prototype);
console.log(Object.getPrototypeOf({}) === Object.prototype, has(Object.getPrototypeOf({ k: 1 }), "isPrototypeOf"));

const O = ctorOf({});
const descriptor = Object.getOwnPropertyDescriptor(O, "prototype");
console.log(typeof O.prototype, O.prototype === Object.prototype, descriptor.writable, descriptor.enumerable, descriptor.configurable);
const A = ctorOf([]);
console.log(A.prototype === Array.prototype, Object.keys(A).length, A.name, A.length);
const E = ctorOf(error);
console.log(E.prototype === Error.prototype, E.prototype.name, E.name);

// A check shaped like zod's isPlainObject: the constructor's prototype must
// be an object that has its own isPrototypeOf.
/** @param {unknown} o */
function isPlainObject(o) {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return false;
  const ctor = /** @type {any} */ (o).constructor;
  if (ctor === undefined) return true;
  if (typeof ctor !== "function") return true;
  const prot = ctor.prototype;
  if (typeof prot !== "object" || prot === null || Array.isArray(prot)) return false;
  return Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf");
}
class Point {
  constructor() {
    this.x = 1;
  }
}
const samples = [{}, { a: 1 }, JSON.parse("{}"), Object.create(null), [], new Point(), new Error("e"), { constructor: 5 }, { constructor: undefined }, "s", 1, null];
console.log(samples.map((sample) => isPlainObject(sample)).join(","));

// A constructor stored on Array.prototype stays one own name, after length.
function Replacement() {}
Array.prototype.constructor = Replacement;
const replacedNames = Object.getOwnPropertyNames(Array.prototype);
console.log(replacedNames.slice(0, 2).join(","), replacedNames.filter((name) => name === "constructor").length, has(Array.prototype, "constructor"));
