// The same reflection over a TypeScript class whose prototype carries an
// accessor: a binding of `C.prototype` used only to read it, its property
// descriptors, names and keys, Object.create from it, and identity with an
// instance's prototype.
class Box {
  a = 1;
  get double(): number {
    return this.a * 2;
  }
  set double(v: number) {
    this.a = v / 2;
  }
  twice(): number {
    return this.a * 2;
  }
}

const proto = Box.prototype;
const d = Object.getOwnPropertyDescriptor(proto, "double");
console.log(typeof d?.get, typeof d?.set, d?.enumerable, d?.configurable);
console.log(
  Object.getOwnPropertyNames(proto).join(","),
  Object.keys(proto).length,
  Reflect.ownKeys(proto).length,
);
console.log(
  Reflect.has(proto, "twice"),
  Object.isFrozen(proto),
  typeof proto,
  proto === Object.getPrototypeOf(new Box()),
);
const made = Object.create(proto);
console.log(made.a === undefined, made instanceof Box, Object.getPrototypeOf(made) === proto);

const direct = Object.getOwnPropertyDescriptor(Box.prototype, "double");
console.log(
  typeof direct?.get,
  "double" in Box.prototype,
  Object.getOwnPropertyNames(Box.prototype).join(","),
);
const real = new Box();
real.double = 8;
console.log(real.a, real.double, proto.isPrototypeOf(real));
