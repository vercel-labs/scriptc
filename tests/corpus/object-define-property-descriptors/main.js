// Object.defineProperty and Object.defineProperties over the objects a
// program builds: data and accessor descriptors, a non-enumerable member,
// a symbol key, descriptor readback, and the throw a frozen target answers.
"use strict";

const plain = { a: 1 };
Object.defineProperty(plain, "b", {
  value: 2,
  enumerable: true,
  writable: true,
  configurable: true,
});
Object.defineProperty(plain, "c", {
  get: function () {
    return this.a + this.b;
  },
});
Object.defineProperty(plain, "hidden", { value: "h" });
console.log(plain.b, plain.c, Object.keys(plain).join(","));
console.log(Object.getOwnPropertyNames(plain).sort().join(","));

const descriptor = Object.getOwnPropertyDescriptor(plain, "c");
console.log(typeof descriptor.get, descriptor.enumerable, descriptor.configurable);

const tag = Symbol.for("tag");
Object.defineProperty(plain, tag, { value: "s", enumerable: true });
console.log(plain[tag], Object.getOwnPropertySymbols(plain).length);

plain.b = 5;
console.log(plain.b, plain.c);

const defined = {};
Object.defineProperties(defined, {
  first: { value: "one", enumerable: true },
  second: {
    get: function () {
      return "two";
    },
  },
});
console.log(defined.first, defined.second, Object.keys(defined).join(","));

const frozen = Object.freeze({ fixed: 1 });
try {
  Object.defineProperty(frozen, "fixed", { value: 2 });
} catch (error) {
  console.log(error.constructor.name, error.message);
}
console.log(frozen.fixed);
