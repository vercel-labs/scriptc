export class Counter {
  /** @type {number} */
  count = 0;

  increment() {
    this.count += 1;
    return this.count;
  }
}
