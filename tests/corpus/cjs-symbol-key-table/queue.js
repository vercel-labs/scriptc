'use strict';

const { kState, kSize, kName, kRun } = require('./symbols');

class Queue {
  // Field declarations keyed by table symbols.
  [kState] = 'idle';

  [kSize] = 0;

  constructor(name) {
    this[kName] = name;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    this[kSize] = this.items.length;
    return this[kSize];
  }

  drain() {
    this[kState] = 'draining';
    // The subclass declares the symbol-keyed method this calls.
    const out = this[kRun](this.items);
    this.items = [];
    this[kSize] = 0;
    this[kState] = 'idle';
    return out;
  }

  get state() {
    return this[kName] + ' is ' + this[kState];
  }
}

module.exports = Queue;
