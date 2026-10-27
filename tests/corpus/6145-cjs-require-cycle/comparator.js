'use strict';

// semver's layout: the class and its export come first ("hoisted class for
// cyclic dependency"), the requires — one of them closing the cycle with
// range.js — after it. When range.js requires this module mid-evaluation,
// Node hands it the exports as they stand: already the class.
const ANY = Symbol('ANY');

class Comparator {
  /** @param {string} value */
  constructor(value) {
    this.value = value;
  }

  /** @param {string} other */
  within(other) {
    return new Range(other).has(this.value);
  }

  static get ANY() {
    return ANY;
  }
}

module.exports = Comparator;

const Range = require('./range.js');
const { trim } = require('./util.js');
console.log('comparator: loaded', trim('  done  '));
