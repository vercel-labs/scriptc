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
