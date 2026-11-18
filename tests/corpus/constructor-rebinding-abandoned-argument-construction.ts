// A construction whose argument evaluation abandons another construction of
// the same class: the abandoned one published the instance its `this` had
// been rebound to before a `finally` threw. The construction that follows
// answers its own instance, as in Node, not that abandoned one.
let pending: Base | null = null;
let throwInFinally = false;
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
const existing = new Derived(1);
existing.a = 10;
function abandon(): number {
  pending = existing;
  throwInFinally = true;
  try {
    new Derived(2);
  } catch (error) {
    console.log("abandoned", (error as Error).message);
  }
  return 3;
}
const fresh = new Derived(abandon());
console.log(fresh === existing, fresh.a, fresh.marker);
