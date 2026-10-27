// An untyped JavaScript base class, the shape of a small npm semaphore.
export class Pool {
  constructor(size) {
    this.size = size;
    this.taken = 0;
  }
  async acquire() {
    this.taken++;
    return this.taken;
  }
  release() {
    this.taken--;
  }
  toString() {
    return `Pool(${this.taken}/${this.size})`;
  }
}
