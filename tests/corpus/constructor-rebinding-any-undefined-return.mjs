// A JavaScript constructor that returns a value the checker only types at
// run time answers the constructed `this` when the value is not an object:
// Node's [[Construct]] keeps the instance `super()` supplied, which here is
// the existing instance the base constructor answered. The publication the
// rebinding path makes happens on that arm too, so the construction does
// not fall back to its freshly allocated object.
let pending = null;
class Base {
  a = 1;
  constructor() {
    if (pending !== null) {
      const p = pending;
      pending = null;
      return p;
    }
  }
}
class Derived extends Base {
  value = 0;
  constructor(value) {
    super();
    this.value = value;
    /** @type {any} */
    const result = undefined;
    return result;
  }
}
const existing = new Derived(1);
existing.a = 10;
pending = existing;
const again = new Derived(2);
console.log(again === existing, again.a, again.value);
