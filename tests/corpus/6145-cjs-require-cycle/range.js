'use strict';

const SEPARATOR = /\s+/;

class Range {
  /** @param {string} spec */
  constructor(spec) {
    this.parts = spec.split(SEPARATOR).map((part) => new Comparator(part));
  }

  /** @param {string} value */
  has(value) {
    return this.parts.some((part) => part.value === value);
  }

  first() {
    return this.parts[0];
  }
}

module.exports = Range;

const Comparator = require('./comparator.js');
console.log('range: loaded');
