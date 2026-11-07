// Set.prototype as a value: every member brand-checks its receiver, so
// calling through the prototype object (or an instance's method value)
// throws a TypeError, while a real Set runs the method.
const prototype = Set.prototype;
const methods = [
  "add",
  "clear",
  "delete",
  "entries",
  "forEach",
  "has",
  "intersection",
  "isDisjointFrom",
  "isSubsetOf",
  "isSupersetOf",
  "keys",
  "symmetricDifference",
  "union",
  "values",
];
const refused = (run) => {
  try {
    run();
    return "no error";
  } catch (error) {
    return error.name + " " + (error instanceof TypeError);
  }
};
console.log("prototype identity", Object.getPrototypeOf(new Set()) === prototype);
const instance = new Set([1]);
// An instance's method value is the same function object as the
// prototype's and brand-checks its receiver the same way.
const methodValues = [
  instance.add,
  instance.clear,
  instance.delete,
  instance.entries,
  instance.forEach,
  instance.has,
  instance.intersection,
  instance.isDisjointFrom,
  instance.isSubsetOf,
  instance.isSupersetOf,
  instance.keys,
  instance.symmetricDifference,
  instance.union,
  instance.values,
];
for (let i = 0; i < methods.length; i += 1) {
  const name = methods[i];
  const throughPrototype = refused(() => prototype[name].call(prototype));
  const sameFunction = prototype[name] === methodValues[i];
  const throughInstance = refused(() => methodValues[i].call(prototype));
  console.log(name, throughPrototype, sameFunction, throughInstance);
}
console.log("size", refused(() => prototype.size));
console.log("method identity", prototype.has === new Set().has);
console.log("combine identity", prototype.union === new Set().union);

// A real Set receiver runs the method through the prototype's value.
console.log("has call", prototype.has.call(new Set([1, 2]), 2));
const added = new Set();
prototype.add.call(added, 7);
console.log("add call", [...added]);
console.log("union call", [...prototype.union.call(new Set([1]), new Set([2]))]);
console.log("values call", [...prototype.values.call(new Set([3, 4]))]);
let visited = 0;
prototype.forEach.call(new Set([5, 6]), (value) => {
  visited += value;
});
console.log("forEach call", visited);

// The store methods accept the receiver's own Set and nothing else.
console.log("map receiver", refused(() => prototype.has.call(new Map(), 1)));
console.log("object receiver", refused(() => prototype.add.call({}, 1)));
console.log("tag", refused(() => prototype[Symbol.toStringTag].length));
