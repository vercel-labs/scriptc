// A class whose prototype carries an accessor, reflected through its
// prototype object: a binding of `C.prototype`, Object.create from it, the
// accessor read and written through the object made from it (with that
// object as `this`), and the prototype's own property descriptors and names.
class Box {
  a = 1;
  get double() {
    return this.a * 2;
  }
  set double(v) {
    this.a = v / 2;
  }
  twice() {
    return this.a * 2;
  }
}

const proto = Box.prototype;
const made = Object.create(proto);
console.log(made.a === undefined, typeof proto, Object.getPrototypeOf(made) === proto, made instanceof Box);
console.log(String(made.double), typeof made.twice);
made.a = 5;
console.log(made.double, made.twice());
made.double = 10;
console.log(made.a, Object.keys(made).join(","));

const d = Object.getOwnPropertyDescriptor(proto, "double");
console.log(typeof d.get, typeof d.set, d.enumerable, d.configurable);
console.log(
  "double" in proto,
  "a" in proto,
  proto.hasOwnProperty("double"),
  Object.getOwnPropertyNames(proto).join(","),
);

const real = new Box();
console.log(real.double, proto.isPrototypeOf(real), proto.isPrototypeOf(made));
console.log(typeof Box.prototype, Object.getOwnPropertyDescriptor(Box.prototype, "twice").writable);
