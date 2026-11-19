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
