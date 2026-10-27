'use strict';

class Counter {
  /** @param {number} start */
  constructor(start) {
    this.value = start;
  }
  next() {
    this.value += 1;
    return this.value;
  }
}

module.exports = Counter;
