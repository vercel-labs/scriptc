// Unannotated Reflect in JavaScript: each member read answers a function
// with Node's name and length, calls through it follow Reflect's rules, and
// the members without a faithful lowering still read as functions.

const target = { a: 1, b: "two" };
console.log(typeof Reflect.isExtensible, Reflect.isExtensible.name, Reflect.isExtensible.length);
console.log(typeof Reflect.preventExtensions, Reflect.preventExtensions.name, Reflect.preventExtensions.length);
console.log(typeof Reflect.getOwnPropertyDescriptor, Reflect.getOwnPropertyDescriptor.name, Reflect.getOwnPropertyDescriptor.length);
console.log(typeof Reflect.has, Reflect.has.name, Reflect.has.length);
console.log(typeof Reflect.deleteProperty, Reflect.deleteProperty.name, Reflect.deleteProperty.length);
console.log(typeof Reflect.get, Reflect.get.name, Reflect.get.length);
console.log(typeof Reflect.set, Reflect.set.name, Reflect.set.length);
console.log(typeof Reflect.ownKeys, Reflect.ownKeys.name, Reflect.ownKeys.length);

console.log(Reflect.has(target, "a"), Reflect.get(target, "a"), Reflect.has(target, "missing"));
console.log(Reflect.ownKeys(target).join(","), Reflect.deleteProperty(target, "missing"));
console.log(Reflect.deleteProperty(target, "b"), Reflect.ownKeys(target).join(","));
console.log(Reflect.getOwnPropertyDescriptor(target, "a").value);

const get = Reflect.get;
const set = Reflect.set;
console.log(get.name, get.length, set.name, set.length);
const receiver = { value: 7 };
const accessor = {
  get doubled() {
    return this.value * 2;
  },
};
console.log(get(accessor, "doubled", receiver), get(accessor, "doubled"));
const sink = {};
console.log(set(sink, "value", 3), sink.value);
console.log(set(sink, "value", 4, undefined), sink.value);

function readThroughMember(fn, object, key) {
  const local = Reflect.get;
  return [fn(object, key), local(object, key)];
}
console.log(readThroughMember(Reflect.get, accessor, "doubled"));
console.log(readThroughMember(Reflect.get, receiver, "value"));

const namespace = Reflect;
console.log(namespace.has(target, "a"), namespace.get(target, "a"), namespace.ownKeys(target).join(","));
console.log(namespace.isExtensible(target));

for (const value of [null, undefined, 1, "text", true]) {
  try {
    console.log(String(Reflect.isExtensible(value)));
  } catch (error) {
    console.log(error.name, error.message);
  }
  try {
    console.log(String(Reflect.preventExtensions(value)));
  } catch (error) {
    console.log(error.name, error.message);
  }
  try {
    console.log(String(Reflect.getOwnPropertyDescriptor(value, "a")));
  } catch (error) {
    console.log(error.name, error.message);
  }
}

// The members whose behavior has no faithful lowering still answer typeof
// "function" and their name.
console.log(typeof Reflect.setPrototypeOf, typeof Reflect.defineProperty, typeof Reflect.construct);
console.log(Reflect.setPrototypeOf.name, Reflect.defineProperty.name, Reflect.construct.name);

const literal = { x: 1 };
console.log(Reflect.preventExtensions(literal), Reflect.isExtensible(literal));
console.log(set(literal, "x", 2), literal.x, set(literal, "y", 3));
