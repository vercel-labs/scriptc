// `@readonly` on a JSDoc-annotated member that is not a property declaration:
// tsc reads the tag as documentation on a getter, a setter, and a method,
// which are already read-only or writable as written. Node never reads the
// comment, so the class keeps the accessors and method its code declares.
class Counter {
  constructor() {
    this.count = 0;
  }

  /** @readonly */
  get size() {
    return this.count;
  }

  /** @readonly */
  set size(next) {
    this.count = next;
  }

  /** @readonly */
  bump() {
    this.count += 1;
    return this.count;
  }
}

const counter = new Counter();
counter.size = 3;
console.log(counter.size, counter.bump());
counter.size = 8;
console.log(counter.size, counter.count);
