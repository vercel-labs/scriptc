// Primitive wrapper objects built with no argument: `new String()` is a
// wrapper over "", `new Number()` over 0 and `new Boolean()` over false.
// This program's only wrapper constructions are zero-argument ones, which
// is the case the "program creates wrappers" fact has to see: the values
// are wrappers (typeof, identity, own properties, the prototype chain, the
// builtin tags), and every coercion reads the slot.

const s = new String();
const n = new Number();
const b = new Boolean();
console.log("typeof", typeof s, typeof n, typeof b);
console.log("values", s.valueOf() === "", n.valueOf() === 0, b.valueOf() === false);
console.log("length", s.length, "0" in s, s.hasOwnProperty("length"));
console.log("keys", Object.keys(s).join(), Object.getOwnPropertyNames(s).join());
console.log("coerce", s + "!", `${s}`, String(s), n * 2, +n, n + 1, Number(n));
console.log("truthy", b ? "wrapper true" : "wrapper false", !!b, b == false);
console.log("methods", s.charAt(0) === "", s.toUpperCase(), s.slice(0, 1), n.toFixed(1), n.toString(2));
console.log("instanceof", s instanceof String, n instanceof Number, b instanceof Boolean, s instanceof Object);
console.log("not instances", "" instanceof String, s instanceof Number);
console.log("tags", Object.prototype.toString.call(s), Object.prototype.toString.call(n), Object.prototype.toString.call(b));
console.log("constructor", s.constructor === String, n.constructor === Number, b.constructor === Boolean);

// Own properties: an empty wrapper has none, and expandos land next to them.
const w = new String();
w.extra = 1;
w[5] = "q";
console.log("expando", Object.keys(w).join(), w.extra, w[5], w.length);
const length = Object.getOwnPropertyDescriptor(w, "length");
console.log("descriptor", length.value, length.writable, length.enumerable, length.configurable);
