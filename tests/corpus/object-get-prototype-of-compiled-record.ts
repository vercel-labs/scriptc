// A compiled record is an ordinary object: Object.setPrototypeOf replaces the
// prototype the plain-object test reads, so a record given null or a custom
// prototype is no longer plain, and one given Object.prototype is.
const plain = { a: 1 };
const nulled = { b: 2 };
Object.setPrototypeOf(nulled, null);
const custom = { c: 3 };
Object.setPrototypeOf(custom, { d: 4 });
const restored = { e: 5 };
Object.setPrototypeOf(restored, { f: 6 });
Object.setPrototypeOf(restored, Object.prototype);
const isPlain = (value: object) => Object.getPrototypeOf(value) === Object.prototype;
console.log(isPlain(plain), isPlain(nulled), isPlain(custom), isPlain(restored));
