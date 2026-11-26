// `Object.getPrototypeOf(value) === Object.prototype` is the plain-object
// test programs write (ui-sdk's isRecord among them). A primitive, an array,
// a function, a Date, a collection, a regular expression, a promise or a
// class instance is not an ordinary object; a plain object is, and so is a
// record the program built as an object literal.
class Instance {
  constructor() {
    this.field = 1;
  }
}
const isPlain = (value) => Object.getPrototypeOf(value) === Object.prototype;
const notPlain = (value) => Object.getPrototypeOf(value) !== Object.prototype;
const values = [
  ["string", "x"],
  ["number", 1],
  ["boolean", true],
  ["object", {}],
  ["object-literal", { a: 1 }],
  ["array", []],
  ["date", new Date(0)],
  ["map", new Map()],
  ["set", new Set()],
  ["regexp", /x/],
  ["promise", Promise.resolve(1)],
  ["function", function named() {}],
  ["instance", new Instance()],
  ["null-prototype", Object.create(null)],
];
for (const [name, value] of values) console.log(name, isPlain(value), notPlain(value));
// A prototype Object.setPrototypeOf installs is the prototype the test sees:
// an array given Object.prototype is a plain object, and a plain object whose
// prototype was replaced with null or a custom object is not.
const givenObjectPrototype = [1];
Object.setPrototypeOf(givenObjectPrototype, Object.prototype);
// A function's replaced prototype is its own: given Object.prototype, the
// folded plain-object comparison answers true.
const givenPrototypeFunction = function named() {};
Object.setPrototypeOf(givenPrototypeFunction, Object.prototype);
console.log("function-given-object-prototype", isPlain(givenPrototypeFunction));
const givenNull = {};
Object.setPrototypeOf(givenNull, null);
const givenCustom = {};
Object.setPrototypeOf(givenCustom, { marker: true });
console.log("array-given-object-prototype", isPlain(givenObjectPrototype));
console.log("object-given-null", isPlain(givenNull), notPlain(givenNull));
console.log("object-given-custom", isPlain(givenCustom), notPlain(givenCustom));
// Node's Object.getPrototypeOf throws for null and undefined.
for (const missing of [null, undefined]) {
  try {
    isPlain(missing);
  } catch (error) {
    console.log("missing", error.message);
  }
}
// The comparison itself throws for null and undefined, so a catch around it
// runs (the fold must not be treated as unable to throw).
try {
  console.log("compare-null", Object.getPrototypeOf(null) === Object.prototype);
} catch (error) {
  console.log("compare-null", error.message);
}
try {
  console.log("compare-undefined", Object.getPrototypeOf(undefined) === Object.prototype);
} catch (error) {
  console.log("compare-undefined", error.message);
}
// Re-boxing a value whose prototype is null keeps the null prototype (a
// checked view is rebuilt from the source on every boxing).
const nullPrototypeArray = [1, 2];
Object.setPrototypeOf(nullPrototypeArray, null);
const reboxedArray = [nullPrototypeArray][0];
console.log("reboxed-null-array", Object.getPrototypeOf(reboxedArray) === null);
const nullPrototypeObject = { k: 1 };
Object.setPrototypeOf(nullPrototypeObject, null);
const reboxedObject = [nullPrototypeObject][0];
console.log("reboxed-null-object", Object.getPrototypeOf(reboxedObject) === null);

// Installing a prototype stores it privately: the array's own keys never list
// the storage.
const privateStorage = [1, 2];
Object.setPrototypeOf(privateStorage, { marker: true });
console.log(
  "array-own-keys",
  Object.getOwnPropertyNames(privateStorage).join(","),
  Reflect.ownKeys(privateStorage).map(String).join(","),
);
