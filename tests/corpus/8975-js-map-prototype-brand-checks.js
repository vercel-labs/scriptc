// Map.prototype as a value: every member brand-checks its receiver, so
// calling one through the prototype object (or an instance's method value)
// throws a TypeError, while a real Map runs it.
const prototype = Map.prototype;
const refused = (run) => {
  try {
    run();
    return "no error";
  } catch (error) {
    return error.name + " " + (error instanceof TypeError);
  }
};
console.log("own names", Object.getOwnPropertyNames(prototype).join(","));
console.log("prototype identity", Object.getPrototypeOf(new Map()) === prototype);
const instance = new Map([["k", 1]]);

// An instance's method value is the same function object as the
// prototype's and brand-checks its receiver the same way.
const member = (name, fromPrototype, fromInstance) => {
  const throughPrototype = refused(() => fromPrototype.call(prototype));
  const sameFunction = fromPrototype === fromInstance;
  const throughInstance = refused(() => fromInstance.call(prototype));
  console.log(name, throughPrototype, sameFunction, throughInstance);
};
member("get", prototype.get, instance.get);
member("set", prototype.set, instance.set);
member("has", prototype.has, instance.has);
member("delete", prototype.delete, instance.delete);
member("clear", prototype.clear, instance.clear);
member("entries", prototype.entries, instance.entries);
member("forEach", prototype.forEach, instance.forEach);
member("keys", prototype.keys, instance.keys);
member("values", prototype.values, instance.values);

console.log("size", refused(() => prototype.size));
console.log("tag", prototype[Symbol.toStringTag]);
console.log("iterator identity", prototype[Symbol.iterator] === prototype.entries);
console.log("constructor", prototype.constructor === Map);

// A real Map receiver runs the method through the prototype's value.
console.log("get call", prototype.get.call(new Map([["a", 2]]), "a"));
const target = new Map();
prototype.set.call(target, "b", 3);
console.log("set call", target.size, target.get("b"));
console.log("has call", prototype.has.call(target, "b"), prototype.has.call(target, "c"));
console.log("delete call", prototype.delete.call(target, "b"), target.size);
console.log("clear call", prototype.clear.call(target), target.size);
const seen = [];
prototype.forEach.call(new Map([["x", 1], ["y", 2]]), (value, key) => {
  seen.push(key, value);
});
console.log("forEach call", seen.join(","));

// The members accept the receiver's own Map and nothing else.
console.log("set receiver", refused(() => prototype.get.call(new Set(), 1)));
console.log("object receiver", refused(() => prototype.get.call({}, 1)));
console.log("array receiver", refused(() => prototype.set.call([], "k", 1)));
console.log("primitive receiver", refused(() => prototype.has.call(7, "k")));

// The descriptor attributes are Node's: methods non-enumerable and
// writable, the size accessor a getter, Symbol.toStringTag read-only.
const getDescriptor = Object.getOwnPropertyDescriptor(prototype, "get");
const sizeDescriptor = Object.getOwnPropertyDescriptor(prototype, "size");
console.log(
  "method descriptor",
  getDescriptor.writable,
  getDescriptor.enumerable,
  getDescriptor.configurable,
);
console.log(
  "size descriptor",
  typeof sizeDescriptor.get,
  "set" in sizeDescriptor,
  sizeDescriptor.enumerable,
  sizeDescriptor.configurable,
);
