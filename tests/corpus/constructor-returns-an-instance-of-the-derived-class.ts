// A base constructor that returns an existing instance: `new Derived()`
// answers that instance, and the derived constructor (its field
// initializers included) runs on it, as in Node. The instance here already
// is one of the class being constructed (made as that class or a subclass
// of it), through a direct construction and through a class value.
let pending: Base | null = null;
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
  b = 2;
  c: number;
  constructor() {
    super();
    this.c = this.a + this.b;
  }
  sum(): number { return this.a + this.b + this.c; }
}
class Leaf extends Derived {
  d = 4;
}
const first = new Derived();
first.a = 10;
first.b = 20;
pending = first;
const again = new Derived();
console.log(again === first, again.a, again.b, again.c, again.sum());

// Through a class value.
const C: typeof Base = Derived;
pending = first;
const viaValue = new C();
console.log(viaValue === first, viaValue instanceof Derived);

// A subclass of the class being constructed is accepted; a base instance
// is not.
const leaf = new Leaf();
leaf.a = 7;
pending = leaf;
const asDerived = new Derived();
console.log(asDerived === leaf, asDerived.a, (asDerived as Leaf).d);
pending = new Leaf();
const asLeaf = new Leaf();
console.log(asLeaf instanceof Leaf, asLeaf.d);
console.log(new Derived() !== first, new Derived().c);

// A construction that a `finally` abandons after the constructor's return
// leaves nothing behind for the next one, and `return this` answers the
// rebound instance.
let boom = false;
class Guarded extends Base {
  e = 5;
  constructor() {
    super();
    try {
      return;
    } finally {
      if (boom) {
        boom = false;
        throw new Error("finally");
      }
    }
  }
}
class ReturnsThis extends Base {
  f = 6;
  constructor() {
    super();
    return this;
  }
}
const guarded = new Guarded();
guarded.a = 30;
pending = guarded;
boom = true;
try {
  new Guarded();
} catch (error) {
  console.log("abandoned", (error as Error).message);
}
const after = new Guarded();
console.log(after === guarded, after.a, after.e);
const returning = new ReturnsThis();
returning.a = 40;
pending = returning;
const again2 = new ReturnsThis();
console.log(again2 === returning, again2.a, again2.f);
