// Prototype reflection on instances of a function-local class without
// methods (zod 4's `$constructor` Definition): the prototype is the class's
// shared prototype object, it chains to the parent's, and members defined
// on it reach every instance.
const installed = new WeakSet();
function factory(name, Parent) {
  class Definition extends Parent {}
  Object.defineProperty(Definition, "name", { value: name });
  return function make(label) {
    const inst = new Definition();
    inst.label = label;
    const proto = Object.getPrototypeOf(inst);
    console.log(name, proto === Definition.prototype, proto === Object.getPrototypeOf(new Definition()));
    if (!installed.has(proto)) {
      installed.add(proto);
      Object.defineProperty(proto, "describe", {
        configurable: true,
        enumerable: false,
        get() {
          return () => `${name}:${this.label}`;
        },
      });
      console.log("installed", name);
    }
    return inst;
  };
}
const makeError = factory("Failure", Error);
const makePlain = factory("Thing", Object);
const a = makeError("a");
const b = makeError("b");
const c = makePlain("c");
console.log(a.describe(), b.describe(), c.describe());
console.log(a instanceof Error, c instanceof Error, Object.keys(a).join(), Object.keys(c).join());
console.log(Object.getPrototypeOf(a) === Object.getPrototypeOf(b), Object.getPrototypeOf(a) === Object.getPrototypeOf(c));
console.log(typeof Object.getPrototypeOf(c).describe, "describe" in a, Object.hasOwn(a, "describe"));

// The prototype has its own non-enumerable `constructor`, the class value
// of that evaluation, as every class prototype does.
function local(Parent) {
  class Definition extends Parent {}
  const proto = Object.getPrototypeOf(new Definition());
  const descriptor = Object.getOwnPropertyDescriptor(proto, "constructor");
  console.log(
    proto.constructor === Definition,
    Object.hasOwn(proto, "constructor"),
    JSON.stringify(Object.getOwnPropertyNames(proto)),
    descriptor.value === Definition,
    descriptor.writable,
    descriptor.enumerable,
    descriptor.configurable,
  );
  return Definition;
}
console.log(local(Object) !== local(Error));
