// Plain objects, arrays, functions and the builtin collections inherit
// Object.prototype's constructor and methods: `o.constructor === Object`,
// `o.valueOf === Object.prototype.valueOf` and the isPlainObject and
// deep-equal idioms built on them (fast-deep-equal, is-plain-obj, lodash)
// answer exactly what Node answers.
function equal(a, b) {
  if (a === b) return true;
  if (a && b && typeof a == "object" && typeof b == "object") {
    if (a.constructor !== b.constructor) return false;
    var length, i, keys;
    if (Array.isArray(a)) {
      length = a.length;
      if (length != b.length) return false;
      for (i = length; i-- !== 0; ) if (!equal(a[i], b[i])) return false;
      return true;
    }
    if (a.constructor === RegExp) return a.source === b.source && a.flags === b.flags;
    if (a.valueOf !== Object.prototype.valueOf) return a.valueOf() === b.valueOf();
    if (a.toString !== Object.prototype.toString) return a.toString() === b.toString();
    keys = Object.keys(a);
    length = keys.length;
    if (length !== Object.keys(b).length) return false;
    for (i = length; i-- !== 0; ) if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
    for (i = length; i-- !== 0; ) {
      var key = keys[i];
      if (!equal(a[key], b[key])) return false;
    }
    return true;
  }
  return a !== a && b !== b;
}
class Point {
  constructor(x) {
    this.x = x;
  }
}
console.log(equal({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), equal({ a: 1 }, { a: "1" }), equal(new Date(0), new Date(0)), equal(new Date(0), new Date(1)));
console.log(equal(/a/g, /a/g), equal(/a/g, /a/i), equal([1, 2], [1, 2, 3]), equal(new Map(), new Set()), equal(new Point(1), new Point(1)), equal(new Point(1), { x: 1 }));
console.log(equal(JSON.parse('{"x":{"y":[1,2]}}'), { x: { y: [1, 2] } }), equal(NaN, NaN), equal(null, {}));

const values = {
  plain: { a: 1 },
  parsed: JSON.parse('{"x":{"y":1}}').x,
  array: [1, 2],
  date: new Date(0),
  regexp: /a/g,
  map: new Map([[1, 2]]),
  set: new Set([1]),
  fn: function () {},
  arrow: () => 1,
  error: new TypeError("x"),
  promise: Promise.resolve(1),
  nullProto: Object.create(null),
  created: Object.create({ inherited: 1 }),
  instance: new Point(2),
};
const ctors = { Object: Object, Array: Array, Date: Date, RegExp: RegExp, Map: Map, Set: Set, Function: Function, TypeError: TypeError, Promise: Promise, Point: Point };
for (const name of Object.keys(values)) {
  const v = values[name];
  const c = v.constructor;
  const hits = Object.keys(ctors).filter((k) => c === ctors[k]);
  console.log(name, hits.join("|") || "-", v.valueOf === Object.prototype.valueOf,
    name === "regexp" ? "-" : v.toString === Object.prototype.toString,
    v.hasOwnProperty === Object.prototype.hasOwnProperty,
    v.propertyIsEnumerable === Object.prototype.propertyIsEnumerable,
    Object.prototype.toString.call(v));
}
const o = { a: 1 };
console.log(typeof Object, typeof Date, typeof Map, Object.name, Date.name, o.constructor.name, typeof o.constructor);
console.log(o.toString(), o.valueOf() === o, Object(o) === o, typeof Object(), Object(null).constructor === Object);
const { Object: O, Map: M } = globalThis;
console.log(O === Object, M === Map, globalThis.Object === Object, O.keys({ z: 1 }).join());
const shadow = { constructor: "mine", valueOf() { return 7; }, toString: 3 };
console.log(shadow.constructor, shadow.valueOf === Object.prototype.valueOf, shadow.toString, shadow.valueOf());

function isPlainObj(value) {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === null || prototype === Object.prototype || Object.getPrototypeOf(prototype) === null) && !(Symbol.toStringTag in value) && !(Symbol.iterator in value);
}
function isPlainTagged(value) {
  if (value == null || Object.prototype.toString.call(value) != "[object Object]") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto.constructor === Object;
}
function isPlainCtor(value) {
  return !!value && typeof value === "object" && (value.constructor === Object || value.constructor === undefined);
}
for (const name of ["plain", "parsed", "array", "nullProto", "created", "instance"]) {
  console.log(name, isPlainObj(values[name]), isPlainTagged(values[name]), isPlainCtor(values[name]));
}
// Primitives answer their wrapper constructors (dequal compares
// `(ctor = a.constructor) === b.constructor` before anything else).
function ctorOf(v) {
  return v.constructor;
}
for (const v of [1, "s", true, 10n]) {
  const c = ctorOf(v);
  console.log(typeof v, c === Number, c === String, c === Boolean, c === BigInt, c === Object, typeof c);
}
function sameCtor(a, b) {
  let c;
  return !!(a && b && (c = a.constructor) === b.constructor) && (c === Number || c === String);
}
console.log(sameCtor(1, 2), sameCtor(1, "1"), sameCtor("a", "b"), sameCtor({}, {}));
