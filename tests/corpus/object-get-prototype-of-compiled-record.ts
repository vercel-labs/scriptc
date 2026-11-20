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
// Re-boxing a record whose prototype is null keeps the null prototype: the
// checked view is rebuilt from the record on every boxing.
const nullPrototype = { g: 6 };
Object.setPrototypeOf(nullPrototype, null);
const reboxed = [nullPrototype][0];
console.log(Object.getPrototypeOf(reboxed) === null, Object.getPrototypeOf(nullPrototype) === null);
// A dynamic read builds the record's snapshot view: the view carries the
// prototype the native record owns, so the plain-object test still sees it.
const viewed = { h: 7 };
Object.setPrototypeOf(viewed, { i: 8 });
const dynamic: any = viewed;
void dynamic.h;
console.log("viewed", isPlain(viewed), Object.getPrototypeOf(viewed) === null);
// A record of a shape that another record gave a prototype is unmodified: its
// view keeps the default prototype when it is built.
const marked = { m: 1 };
Object.setPrototypeOf(marked, { n: 2 });
const unmodified = { m: 3 };
const dynamicUnmodified: any = unmodified;
void dynamicUnmodified.m;
console.log("unmodified", Object.getPrototypeOf(unmodified) === Object.prototype);
