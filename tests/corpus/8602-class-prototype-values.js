// A class's prototype read as a value in any read position: passed to a
// call, compared, inspected with the Object reflection surface, and used as
// an inherited receiver. The complete view answers the own properties the
// class declares — constructor, methods and accessors, in declaration order,
// with the specification's descriptors — and never the instance fields.
class Base {
  constructor(n) {
    this.n = n;
  }
  get label() {
    return "base:" + this.n;
  }
  set label(v) {
    this.n = Number(v);
  }
  m() {
    return this.n * 2;
  }
  #secret = 7;
  #priv() {
    return this.#secret;
  }
  peek() {
    return this.#priv();
  }
}
class Derived extends Base {
  m() {
    return super.m() + 1;
  }
  static make(n) {
    return new Derived(n);
  }
}
const derived = Derived.make(21);
console.log(derived.m(), derived.label, derived.peek());
console.log(typeof Base.prototype, typeof Derived.prototype);
console.log(Base.prototype === Base.prototype, Derived.prototype === Derived.prototype);
console.log(Base.prototype.constructor === Base, Derived.prototype.constructor === Derived);
console.log(Object.getPrototypeOf(Derived.prototype) === Base.prototype);
console.log(Object.getPrototypeOf(Base.prototype) === Object.prototype);
// The Test262 idiom: a prototype has no own property named for a private
// member, and an instance has none for its class's members. Constructor
// capsules do not model their own-property tables yet, so the receiver is
// the prototype or the instance here.
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
console.log(
  own(Base.prototype, "m"),
  own(Base.prototype, "#secret"),
  own(Base.prototype, "#priv"),
  own(derived, "#secret"),
  own(Base.prototype, "constructor"),
  own(Base.prototype, "nope"),
);
console.log(Object.getOwnPropertyNames(Base.prototype).join(","));
console.log(Object.getOwnPropertyNames(Derived.prototype).join(","));
const method = Object.getOwnPropertyDescriptor(Base.prototype, "m");
console.log(method.writable, method.enumerable, method.configurable, typeof method.value);
const accessor = Object.getOwnPropertyDescriptor(Base.prototype, "label");
console.log("value" in accessor, typeof accessor.get, typeof accessor.set);
console.log(accessor.enumerable, accessor.configurable);
console.log(Object.keys(Base.prototype).length);
const inherited = [];
for (const key in Base.prototype) inherited.push(key);
console.log(inherited.length);
// The value handed to a plain function keeps its identity and its shape.
function describe(prototype) {
  return Object.getOwnPropertyNames(prototype).length + ":" + prototype.constructor.name;
}
console.log(describe(Base.prototype), describe(Derived.prototype));
// A foreign receiver inherits the reflected methods.
const foreign = Object.create(Base.prototype);
foreign.n = 5;
console.log(foreign.m(), foreign.label, foreign instanceof Base);
console.log(new Base(3).m(), new Derived(4).m());
