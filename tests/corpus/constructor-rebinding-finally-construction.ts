// A construction of the same class runs in a `finally` block after the
// constructor's `return this` published the instance it was rebound to:
// the construction that survives still answers that instance, as in Node.
let pending: Base | null = null;
let buildNested = false;
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
      return this;
    } finally {
      if (buildNested) {
        buildNested = false;
        new Derived(2);
      }
    }
  }
}
const existing = new Derived(1);
existing.a = 10;
pending = existing;
buildNested = true;
const again = new Derived(0);
console.log(again === existing, again.a, again.marker);
