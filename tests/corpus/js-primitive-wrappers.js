// Primitive wrapper objects: new String/Number/Boolean and Object(primitive).
// A wrapper is an object (typeof, identity, own properties, prototype
// chain, instanceof, its builtin tag) and converts to its primitive in every
// coercion (ToPrimitive through valueOf/toString, ToNumber, property keys,
// method receivers). ToBoolean of any wrapper is true.

const s = new String("lego");
const n = new Number(4.5);
const b = new Boolean(false);
console.log("typeof", typeof s, typeof n, typeof b);
console.log("identity", s === s, new String("a") === new String("a"), s == "lego", s === "lego");
console.log("valueOf", s.valueOf() === "lego", n.valueOf() + 1, b.valueOf());
console.log("coerce", s + "!", `${s}`, String(s), n * 2, +n, n + 1, Number(n));
console.log("truthy", b ? "wrapper true" : "wrapper false", !!b, b == false);
console.log("string reads", s.length, s[1], s.charAt(0), s.toUpperCase(), s.slice(1, 3));
console.log("number methods", n.toFixed(2), n.toString(), new Number(255).toString(16));
console.log("instanceof", s instanceof String, n instanceof Number, b instanceof Boolean, s instanceof Object);
console.log("not instances", "x" instanceof String, s instanceof Number);
console.log("tags", Object.prototype.toString.call(s), Object.prototype.toString.call(n), Object.prototype.toString.call(b));
console.log("constructor", s.constructor === String, n.constructor === Number, b.constructor === Boolean);
console.log("prototype", Object.getPrototypeOf(s) === Object.getPrototypeOf(new String("z")));

// Own properties: index properties and length, then expandos.
const w = new String("ab");
w.extra = 1;
w[5] = "q";
console.log("keys", Object.keys(w).join(), Object.getOwnPropertyNames(w).join());
console.log("in", "0" in w, 2 in w, "length" in w, w.hasOwnProperty("length"));
const d = Object.getOwnPropertyDescriptor(w, "0");
console.log("descriptor", d.value, d.writable, d.enumerable, d.configurable);
const keyed = {};
keyed[new String("k")] = 1;
keyed[new Number(2)] = 2;
console.log("property keys", Object.keys(keyed).join());

// Overridden coercion hooks are honored.
const hooked = new Number(4);
hooked.valueOf = function () {
  return 10;
};
console.log("hooks", hooked + 1, `${hooked}`, String(hooked));

// ToObject.
const o = Object("x");
const p = Object(5);
const q = Object(true);
const r = {};
console.log("Object()", typeof o, o.length, o == "x", o instanceof String, typeof p, p + 1, q.valueOf());
console.log("Object() of objects", Object(r) === r, typeof Object(null), typeof Object(undefined));

// Brand checks on the prototype methods, read through a wrapper.
const numberValueOf = new Number(0).valueOf;
const stringToString = new String("").toString;
console.log("method values", numberValueOf.call(n), stringToString.call(s), numberValueOf === n.valueOf);
try {
  numberValueOf.call(s);
} catch (error) {
  console.log("brand", error.constructor.name, error.message);
}

// The prototypes are themselves wrappers of "", 0 and false, as in Node.
const stringPrototype = Object.getPrototypeOf(s);
const numberPrototype = Object.getPrototypeOf(n);
const booleanPrototype = Object.getPrototypeOf(new Boolean(true));
console.log("prototype values", stringPrototype.valueOf() === "", numberPrototype.valueOf(), booleanPrototype.valueOf());
console.log("prototype strings", stringPrototype.length, `${numberPrototype}`, String(booleanPrototype), numberPrototype + 1);
console.log("prototype tags", Object.prototype.toString.call(stringPrototype), Object.prototype.toString.call(numberPrototype));
console.log("prototype instances", stringPrototype instanceof String, Object.getOwnPropertyNames(stringPrototype).slice(0, 2).join());

// A string-named method call on a dynamic object reads the member once.
let trimReads = 0;
const trimmed = {
  get trim() {
    trimReads++;
    return trimReads === 1 ? () => "first read" : () => "second read";
  },
};
const callTrim = (value) => value.trim();
console.log("member reads", callTrim(trimmed), trimReads, callTrim("  text  "));

// A graph that shares its objects, in a program with wrappers: the wrapper
// check before console.log searches each object once.
let sharedGraph = { leaf: 1 };
for (let i = 0; i < 40; i++) sharedGraph = { left: sharedGraph, right: sharedGraph };
console.log(sharedGraph);
