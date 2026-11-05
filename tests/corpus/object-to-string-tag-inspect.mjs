// util.inspect brackets a plain object's Symbol.toStringTag after its prefix.
const hidden = {};
Object.defineProperty(hidden, Symbol.toStringTag, { value: "X" });
const keyed = { a: 1 };
Object.defineProperty(keyed, Symbol.toStringTag, { value: "Y" });
const bare = Object.create(null);
Object.defineProperty(bare, Symbol.toStringTag, { value: "N" });
const bareKeyed = Object.create(null);
bareKeyed.k = 1;
Object.defineProperty(bareKeyed, Symbol.toStringTag, { value: "N" });
const empty = {};
Object.defineProperty(empty, Symbol.toStringTag, { value: "" });
const named = { z: 1 };
Object.defineProperty(named, Symbol.toStringTag, { value: "Object" });
const getter = { c: 1 };
Object.defineProperty(getter, Symbol.toStringTag, { get: () => "G" });
const throwing = { c: 1 };
Object.defineProperty(throwing, Symbol.toStringTag, {
  get() {
    throw new Error("boom");
  },
});
const numeric = { c: 1 };
Object.defineProperty(numeric, Symbol.toStringTag, { value: 7 });
const inherited = Object.create(hidden);
const listed = { [Symbol.toStringTag]: "Z", b: 2 };

console.log(hidden, keyed, bare, bareKeyed);
console.log(empty, named, getter, throwing, numeric);
console.log(inherited, listed, [keyed], { keyed });
console.log({ a: { b: { keyed, bareKeyed, named, hidden } } });
console.log(Math, JSON, Reflect, { a: { b: { c: Math } } });
console.log(
  Object.prototype.toString.call(hidden),
  String(keyed),
  `${inherited}`,
);
