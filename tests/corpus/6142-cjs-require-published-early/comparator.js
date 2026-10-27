'use strict';

// The semver layout: the class and its export come first, the requires its
// methods use come after. Publishing the class runs none of its methods, so
// no read can happen before the requires ran.
const ANY = Symbol('ANY');

class Comparator {
  static get ANY() {
    return ANY;
  }

  static describe() {
    return `Comparator(${typeof parseOptions})`;
  }

  /**
   * @param {string} text
   * @param {{ loose?: boolean }} [options]
   */
  constructor(text, options) {
    this.mode = parseOptions(options);
    this.text = text.trim();
    debug('comparator', this.text, this.mode);
  }

  /** @param {string} other */
  test(other) {
    return path.basename(other) === this.text;
  }
}

module.exports = Comparator;

const parseOptions = require('./parse-options.js');
const { debug } = require('./debug.js');
const path = require('path');
