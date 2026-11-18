// A constructor that can answer an instance of its own (an early cached-instance return) still answers its `this` on the path that returns it through a `finally`: the finalizer constructs the same class, whose construction consumes whatever the class result slot held, so the instance this constructor ended with is published again once the block finishes. Node answers the rebound instance either way.
let pending: Base | null = null;
let cache: Derived | null = null;
let nested = false;
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
  marker = 0;
  constructor(marker: number) {
    super();
    this.marker = marker;
    if (cache !== null) return cache;
    try {
      return this;
    } finally {
      if (nested) {
        nested = false;
        const inner = new Derived(9);
        console.log("inner", inner.marker, inner.a);
      }
    }
  }
}
const early = new Derived(1);
early.a = 10;
cache = early;
const cached = new Derived(2);
console.log("cached", cached === early, cached.a, cached.marker);

// The cached return is not taken here: the construction answers the instance
// its `super()` rebound it to, after the finally's own construction ran.
cache = null;
pending = early;
nested = true;
const again = new Derived(3);
console.log("again", again === early, again.a, again.marker);

// The same path with no construction in the finalizer answers the same
// instance.
pending = early;
const plain = new Derived(4);
console.log("plain", plain === early, plain.a, plain.marker);
