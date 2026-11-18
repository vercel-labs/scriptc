// A construction through a base-typed class value answers the class it built, not a sibling class whose construction the arguments abandoned: that sibling published its own instance before its `finally` threw, and its result slot still holds it. The construction reads a descendant's slot only when the object it allocated is that descendant.
let pending: Base | null = null;
let throwInFinally = false;
class Base {
  a = 1;
  constructor(_n?: number) {
    if (pending !== null) {
      const p = pending;
      pending = null;
      return p;
    }
  }
}
class Derived extends Base {
  d = 2;
}
class Sibling extends Base {
  s = 3;
  constructor() {
    super();
    try {
      return;
    } finally {
      if (throwInFinally) {
        throwInFinally = false;
        throw new Error("finally");
      }
    }
  }
}

// The argument evaluation abandons a Sibling construction after its
// publication; the construction through the value builds a Derived.
function abandon(): number {
  throwInFinally = true;
  try {
    new Sibling();
  } catch (error) {
    console.log("abandoned", (error as Error).message);
  }
  return 3;
}
const Value: typeof Base = Derived;
const fresh = new Value(abandon());
console.log(fresh instanceof Derived, (fresh as any).d, (fresh as any).s);

// The sibling's own slot stays published until the next sibling
// construction clears it, which answers its own instance.
const sibling = new Sibling();
console.log(sibling instanceof Sibling, sibling.s);
