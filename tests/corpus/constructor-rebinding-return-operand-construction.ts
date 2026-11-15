// A rebinding constructor whose `return this.method()` operand constructs
// another instance of the class: the return answers this constructor's
// `this`, not the instance its operand constructed, as in Node.
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
  marker = 0;
  constructor(marker: number) {
    super();
    this.marker = marker;
    return this.finish(marker);
  }
  finish(marker: number): this {
    if (marker === 0) new Derived(1);
    return this;
  }
}
const existing = new Derived(1);
existing.a = 10;
pending = existing;
const again = new Derived(0);
console.log(again === existing, again.a, again.marker);
