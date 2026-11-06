// Static members of builtin constructors read through untyped values
// (`globalThis[name]`, a sloppy-mode `this`, `o.constructor`) are Node's:
// the functions their static spellings read, Node's constants, and
// functions with Node's name and length for the others.
const statics = {
  Object: ["assign", "keys", "values", "entries", "freeze", "is", "create", "defineProperty", "seal", "groupBy"],
  Array: ["isArray", "from", "fromAsync", "of"],
  Promise: ["all", "allSettled", "any", "race", "resolve", "reject", "withResolvers", "try"],
  Number: ["isFinite", "isInteger", "isNaN", "isSafeInteger", "parseFloat", "parseInt"],
  String: ["fromCharCode", "fromCodePoint", "raw"],
  BigInt: ["asUintN", "asIntN"],
  Date: ["now", "parse", "UTC"],
  Map: ["groupBy"],
  Error: ["captureStackTrace", "isError"],
  ArrayBuffer: ["isView"],
};
// An untyped read: the name is not known to the checker.
function constructorNamed(name) {
  return globalThis[name];
}
for (const name of Object.keys(statics)) {
  const C = constructorNamed(name);
  const row = statics[name].map((key) => {
    const member = C[key];
    return `${key}:${typeof member}/${member.name}/${member.length}/${key in C}`;
  });
  console.log(name, row.join(" "));
}

const number = constructorNamed("Number");
console.log(number.MAX_SAFE_INTEGER, number.MIN_SAFE_INTEGER, number.EPSILON, number.MAX_VALUE);
console.log(number.MIN_VALUE, number.NaN, number.POSITIVE_INFINITY, number.NEGATIVE_INFINITY);
console.log(constructorNamed("Float64Array").BYTES_PER_ELEMENT, "missing" in number, typeof number.missing);

const object = constructorNamed("Object");
const array = constructorNamed("Array");
const string = constructorNamed("String");
const date = constructorNamed("Date");
console.log(object.keys === Object.keys, object.assign === Object.assign, object.freeze === Object.freeze);
console.log(array.isArray === Array.isArray, array.from === Array.from, date.now === Date.now);
console.log(number.isInteger === Number.isInteger, number.parseInt === Number.parseInt);
console.log(string.fromCharCode === String.fromCharCode, object.keys === object.keys);
console.log(object.keys({ a: 1, b: 2 }), object.entries({ c: 3 }), array.isArray([1]), array.from("ab"));
console.log(number.isInteger(3), number.isSafeInteger(2 ** 60), number.parseFloat("1.5x"), number.parseInt("ff", 16));
console.log(string.fromCharCode(72, 105), string.fromCodePoint(128512).length, typeof date.now());
console.log(Object.isFrozen(object.freeze({ d: 4 })), object.is(NaN, NaN));

const descriptor = Object.getOwnPropertyDescriptor(constructorNamed("Promise"), "resolve");
console.log(typeof descriptor.value, descriptor.writable, descriptor.enumerable, descriptor.configurable);
const constant = Object.getOwnPropertyDescriptor(number, "EPSILON");
console.log(constant.value, constant.writable, constant.enumerable, constant.configurable);
console.log(Object.getOwnPropertyDescriptor(number, "missing"));

function sloppyPromise() {
  return this.Promise;
}
const promise = sloppyPromise();
console.log(typeof promise.resolve === "function" ? "has resolve" : "no resolve", promise.all.length);

const plain = JSON.parse('{"x":1}');
console.log(typeof plain.constructor.keys, plain.constructor.keys(plain), plain.constructor.getPrototypeOf.length);
console.log(typeof [].constructor.isArray, typeof JSON.parse("[]").constructor.of);

const replaced = constructorNamed("Map");
replaced.groupBy = "own";
console.log(replaced.groupBy, typeof constructorNamed("Map").groupBy);

// Assignments and deletions treat the static members as own properties with
// Node's attributes: a constant is read-only, an assigned method keeps the
// member non-enumerable, and a deleted member stays deleted.
const numberCtor = constructorNamed("Number");
numberCtor.EPSILON = 1;
console.log(numberCtor.EPSILON === Number.EPSILON);
function strictWrite() {
  "use strict";
  try {
    numberCtor.MAX_SAFE_INTEGER = 1;
    return "written";
  } catch (error) {
    return error.name;
  }
}
console.log(strictWrite(), numberCtor.MAX_SAFE_INTEGER);
const dateCtor = constructorNamed("Date");
const originalParse = dateCtor.parse;
dateCtor.parse = function parse() {
  return 0;
};
console.log(Object.keys(dateCtor), dateCtor.propertyIsEnumerable("parse"), dateCtor.parse === originalParse);
delete dateCtor.UTC;
console.log("UTC" in dateCtor, typeof dateCtor.UTC);

// The static members follow `prototype` in the own-key order.
console.log(Object.getOwnPropertyNames(constructorNamed("Array")).join(","));
console.log(Object.getOwnPropertyNames(object).slice(0, 6).join(","));
